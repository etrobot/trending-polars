import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 20;

/**
 * v19→20：
 *
 * - `stock_ranking` 新增维度 5「相对强度」的三列。评分从四维扩到五维（原始满分 120，
 *   对外折算到 100 分制），旧行没有这一列，读取时按中性分处理。
 * - `sector_trend_daily` 新增 `adjust_direction`：过去多周期交叉验证无论升级还是降级
 *   都写 `downgraded=1`，审计时分不清方向。现在 `downgraded` 只表示降级，
 *   `adjust_direction` 记录 'up' / 'down'。
 * - `paper_instruction` 新增 `signal_score`：仓位改为按评分分档缩放后，执行时必须
 *   拿到与计划时同一个总分，否则计划量与成交量会不一致。
 */
export function migrateV19(database: DatabaseSync): void {
  const rankingCols = database.prepare(`PRAGMA table_info(stock_ranking)`).all() as Array<{ name: string }>;
  const rankingNames = new Set(rankingCols.map((column) => column.name));
  if (rankingCols.length && !rankingNames.has('relative_strength_score')) {
    database.exec(`
      ALTER TABLE stock_ranking ADD COLUMN relative_strength_score REAL;
      ALTER TABLE stock_ranking ADD COLUMN relative_strength_label TEXT NOT NULL DEFAULT '';
      ALTER TABLE stock_ranking ADD COLUMN relative_strength_pct REAL;
    `);
  }
  const trendCols = database.prepare(`PRAGMA table_info(sector_trend_daily)`).all() as Array<{ name: string }>;
  const trendNames = new Set(trendCols.map((column) => column.name));
  if (trendCols.length && !trendNames.has('adjust_direction')) {
    database.exec(`ALTER TABLE sector_trend_daily ADD COLUMN adjust_direction TEXT`);
  }
  const instructionCols = database.prepare(`PRAGMA table_info(paper_instruction)`).all() as Array<{ name: string }>;
  if (instructionCols.length && !instructionCols.some((column) => column.name === 'signal_score')) {
    database.exec(`ALTER TABLE paper_instruction ADD COLUMN signal_score REAL`);
  }
}

/** v16→17: 允许 state_id 为 0（数据不足），配合 CHECK 约束从 BETWEEN 1 AND 7 改为 0 AND 7。 */
export function migrateV16(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  if (Number(version?.user_version ?? 0) >= 17) return;
  // 检查 sector_trend_daily 是否已经按新 schema 创建（避免与 initializeSchema 冲突）。
  const cols = database.prepare(`PRAGMA table_info(sector_trend_daily)`).all() as Array<{ name: string }>;
  const hasAdxColumn = cols.some((c) => c.name === 'adx');
  if (hasAdxColumn) {
    // initializeSchema 已经建了带 adx 列的新表，CHECK 已经是 BETWEEN 0 AND 8，无需迁移。
    database.exec(`PRAGMA user_version = 17;`);
    return;
  }
  database.exec(`
    CREATE TABLE sector_trend_daily_new (
      date TEXT NOT NULL,
      sector_code TEXT NOT NULL REFERENCES sector_info(code) ON UPDATE CASCADE,
      sector_name TEXT NOT NULL,
      state_id INTEGER NOT NULL CHECK (state_id BETWEEN 0 AND 7),
      state_name TEXT NOT NULL,
      trend TEXT NOT NULL DEFAULT '',
      latest REAL,
      ma5 REAL,
      ma20 REAL,
      near_high TEXT NOT NULL DEFAULT '',
      volume_trend TEXT NOT NULL DEFAULT '',
      strategy_action TEXT NOT NULL DEFAULT '',
      strategy_label TEXT NOT NULL DEFAULT '',
      strategy_position TEXT NOT NULL DEFAULT '',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (date, sector_code)
    ) WITHOUT ROWID;
    INSERT INTO sector_trend_daily_new
      (date, sector_code, sector_name, state_id, state_name, trend, latest, ma5, ma20,
       near_high, volume_trend, strategy_action, strategy_label, strategy_position, computed_at)
    SELECT date, sector_code, sector_name, state_id, state_name, trend, latest, ma5, ma20,
           near_high, volume_trend, strategy_action, strategy_label, strategy_position, computed_at
    FROM sector_trend_daily;
    DROP TABLE sector_trend_daily;
    ALTER TABLE sector_trend_daily_new RENAME TO sector_trend_daily;
    -- 修复历史脏数据：state_name 与 state_id 不匹配的行
    UPDATE sector_trend_daily SET state_id = 0 WHERE state_name = '数据不足' AND state_id != 0;
    PRAGMA user_version = 17;
  `);
}

/**
 * v18→19: 板块指数表支持日/周/月三周期，sector_trend_daily 允许 state_id=8（筑底成功）。
 *
 * - `block_daily_price` 增加 `period` 列（'01'=日 / '11'=周 / '21'=月），
 *   主键扩展为 (block_code, date, period)；旧数据默认 '01'。
 * - `sector_trend_daily` 的 CHECK 从 `BETWEEN 0 AND 7` 改为 `BETWEEN 0 AND 8`，
 *   与 scoring-engine 的 STATE_TABLE 对齐。
 * - 新增 `adx` / `plus_di` / `minus_di` / `downgraded` 字段，供审计与 UI 展示。
 */
export function migrateV18(database: DatabaseSync): void {
  const version = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const currentVersion = Number(version?.user_version ?? 0);

  // ---- 1. block_daily_price 加 period 列并扩展主键 ----
  const blockCols = database.prepare(`PRAGMA table_info(block_daily_price)`).all() as Array<{ name: string }>;
  const blockHasPeriod = blockCols.some((c) => c.name === 'period');

  // ---- 2. sector_trend_daily 允许 state_id=8 + 新增 ADX/downgraded 字段 ----
  const trendCols = database.prepare(`PRAGMA table_info(sector_trend_daily)`).all() as Array<{ name: string }>;
  const trendHasAdx = trendCols.some((c) => c.name === 'adx');

  // 版本号已达标且 schema 已正确应用，才跳过；否则基于实际 schema 状态决定是否迁移，
  // 以修复 user_version 与 schema 不一致的破损状态（例如迁移中途失败但版本号已写入）。
  if (currentVersion >= 19 && blockHasPeriod && trendHasAdx) return;

  if (!blockHasPeriod) {
    // 旧表无 period 列：先 ADD COLUMN，再重建表加 CHECK 约束和复合主键。
    database.exec(`ALTER TABLE block_daily_price ADD COLUMN period TEXT NOT NULL DEFAULT '01'`);
    database.exec(`
      DROP INDEX IF EXISTS idx_block_price_code_date;
      CREATE TABLE block_daily_price_new (
        block_code TEXT NOT NULL REFERENCES sector_info(code) ON UPDATE CASCADE,
        block_name TEXT NOT NULL,
        date TEXT NOT NULL,
        period TEXT NOT NULL DEFAULT '01' CHECK (period IN ('01', '11', '21')),
        open REAL NOT NULL,
        close REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,
        change_rate REAL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (block_code, date, period)
      ) WITHOUT ROWID;
      INSERT INTO block_daily_price_new
        (block_code, block_name, date, period, open, close, high, low, volume, amount, change_rate, created_at)
      SELECT block_code, block_name, date, period, open, close, high, low, volume, amount, change_rate, created_at
      FROM block_daily_price;
      DROP TABLE block_daily_price;
      ALTER TABLE block_daily_price_new RENAME TO block_daily_price;
      CREATE INDEX IF NOT EXISTS idx_block_price_code_date ON block_daily_price(block_code, date);
      CREATE INDEX IF NOT EXISTS idx_block_price_code_period_date ON block_daily_price(block_code, period, date);
    `);
  } else if (!blockCols.some((c) => c.name === 'created_at')) {
    // initializeSchema 已经建了完整的新表，无需任何操作。
  }

  if (!trendHasAdx) {
    database.exec(`
      CREATE TABLE sector_trend_daily_new (
        date TEXT NOT NULL,
        sector_code TEXT NOT NULL REFERENCES sector_info(code) ON UPDATE CASCADE,
        sector_name TEXT NOT NULL,
        state_id INTEGER NOT NULL CHECK (state_id BETWEEN 0 AND 8),
        state_name TEXT NOT NULL,
        trend TEXT NOT NULL DEFAULT '',
        latest REAL,
        ma5 REAL,
        ma20 REAL,
        near_high TEXT NOT NULL DEFAULT '',
        volume_trend TEXT NOT NULL DEFAULT '',
        adx REAL,
        plus_di REAL,
        minus_di REAL,
        downgraded INTEGER NOT NULL DEFAULT 0,
        original_state_id INTEGER,
        original_state_name TEXT,
        strategy_action TEXT NOT NULL DEFAULT '',
        strategy_label TEXT NOT NULL DEFAULT '',
        strategy_position TEXT NOT NULL DEFAULT '',
        computed_at TEXT NOT NULL,
        PRIMARY KEY (date, sector_code)
      ) WITHOUT ROWID;
      INSERT INTO sector_trend_daily_new
        (date, sector_code, sector_name, state_id, state_name, trend, latest, ma5, ma20,
         near_high, volume_trend, strategy_action, strategy_label, strategy_position, computed_at)
      SELECT date, sector_code, sector_name, state_id, state_name, trend, latest, ma5, ma20,
             near_high, volume_trend, strategy_action, strategy_label, strategy_position, computed_at
      FROM sector_trend_daily;
      DROP TABLE sector_trend_daily;
      ALTER TABLE sector_trend_daily_new RENAME TO sector_trend_daily;
    `);
  }
  database.exec(`PRAGMA user_version = 19;`);
}

/** v15: 移除 limit_up_record 中的冗余名称列，改由 JOIN info 表获取。 */
export function migrateV15(database: DatabaseSync): void {
  const columns = database.prepare(`PRAGMA table_info(limit_up_record)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  if (names.has('stock_name')) {
    database.exec(`ALTER TABLE limit_up_record DROP COLUMN stock_name`);
  }
  if (names.has('sector_name')) {
    database.exec(`ALTER TABLE limit_up_record DROP COLUMN sector_name`);
  }
}

export function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS stock_info (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      market TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (length(code) = 6 AND code NOT GLOB '*[^0-9]*')
    );

    CREATE TABLE IF NOT EXISTS sector_info (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS limit_up_record (
      date TEXT NOT NULL,
      stock_code TEXT NOT NULL REFERENCES stock_info(code) ON UPDATE CASCADE,
      sector_code TEXT NOT NULL REFERENCES sector_info(code) ON UPDATE CASCADE,
      continue_num INTEGER NOT NULL CHECK (continue_num BETWEEN 1 AND 15),
      reason_type TEXT NOT NULL DEFAULT '',
      sector_change REAL NOT NULL DEFAULT 0,
      latest REAL,
      change_rate REAL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (date, stock_code)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS stock_daily_price (
      stock_code TEXT NOT NULL REFERENCES stock_info(code) ON UPDATE CASCADE,
      stock_name TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      close REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      change_rate REAL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (stock_code, date)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS index_daily_price (
      symbol TEXT NOT NULL,
      index_name TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      close REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      change_rate REAL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (symbol, date)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS block_daily_price (
      block_code TEXT NOT NULL REFERENCES sector_info(code) ON UPDATE CASCADE,
      block_name TEXT NOT NULL,
      date TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '01' CHECK (period IN ('01', '11', '21')),
      open REAL NOT NULL,
      close REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      change_rate REAL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (block_code, date, period)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS sector_trend_daily (
      date TEXT NOT NULL,
      sector_code TEXT NOT NULL REFERENCES sector_info(code) ON UPDATE CASCADE,
      sector_name TEXT NOT NULL,
      state_id INTEGER NOT NULL CHECK (state_id BETWEEN 0 AND 8),
      state_name TEXT NOT NULL,
      trend TEXT NOT NULL DEFAULT '',
      latest REAL,
      ma5 REAL,
      ma20 REAL,
      near_high TEXT NOT NULL DEFAULT '',
      volume_trend TEXT NOT NULL DEFAULT '',
      adx REAL,
      plus_di REAL,
      minus_di REAL,
      downgraded INTEGER NOT NULL DEFAULT 0,
      adjust_direction TEXT,
      original_state_id INTEGER,
      original_state_name TEXT,
      strategy_action TEXT NOT NULL DEFAULT '',
      strategy_label TEXT NOT NULL DEFAULT '',
      strategy_position TEXT NOT NULL DEFAULT '',
      computed_at TEXT NOT NULL,
      PRIMARY KEY (date, sector_code)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ranking_factor (
      date TEXT NOT NULL,
      stock_code TEXT NOT NULL REFERENCES stock_info(code) ON UPDATE CASCADE,
      factor_name TEXT NOT NULL,
      val_numeric REAL,
      val_text TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (date, stock_code, factor_name)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS stock_ranking (
      date TEXT NOT NULL,
      stock_code TEXT NOT NULL REFERENCES stock_info(code) ON UPDATE CASCADE,
      stock_name TEXT NOT NULL,
      rank INTEGER NOT NULL,
      total_score REAL NOT NULL DEFAULT 0,
      trend_score REAL NOT NULL DEFAULT 0,
      momentum_score REAL,
      volume_score REAL,
      volume_price_score REAL,
      position_score REAL,
      volatility_trend_score REAL,
      alignment TEXT NOT NULL DEFAULT '',
      trend_strength REAL,
      volume_label TEXT NOT NULL DEFAULT '',
      volume_price_label TEXT NOT NULL DEFAULT '',
      position_label TEXT NOT NULL DEFAULT '',
      volatility_class TEXT NOT NULL DEFAULT '',
      volatility_label TEXT NOT NULL DEFAULT '',
      relative_strength_score REAL,
      relative_strength_label TEXT NOT NULL DEFAULT '',
      relative_strength_pct REAL,
      limit_up_count_20d INTEGER,
      sector_trend_name TEXT NOT NULL DEFAULT '',
      sector_trend_state_id INTEGER,
      latest_price REAL,
      latest_change_rate REAL,
      sector_code TEXT REFERENCES sector_info(code) ON UPDATE CASCADE,
      sector_name TEXT NOT NULL DEFAULT '',
      continue_num INTEGER,
      reason_type TEXT NOT NULL DEFAULT '',
      sector_change REAL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (date, stock_code)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ranking_snapshot (
      date TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      total_stocks INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS historical_snapshot (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      source TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      as_of_date TEXT NOT NULL,
      universe_as_of_date TEXT NOT NULL,
      requested_days INTEGER NOT NULL,
      warmup_days INTEGER NOT NULL,
      calendar_json TEXT NOT NULL,
      stock_codes_json TEXT NOT NULL,
      index_symbols_json TEXT NOT NULL,
      failed_stocks INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_instruction (
      id TEXT PRIMARY KEY,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      stock_code TEXT NOT NULL REFERENCES stock_info(code) ON UPDATE CASCADE,
      signal_date TEXT NOT NULL,
      signal_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      rank INTEGER,
      signal_score REAL,
      reason TEXT NOT NULL DEFAULT '',
      execution_window TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      submitted_at TEXT,
      completed_at TEXT,
      broker_status TEXT,
      execution_price REAL
    );

    CREATE INDEX IF NOT EXISTS idx_limit_up_date
      ON limit_up_record(date);
    CREATE INDEX IF NOT EXISTS idx_limit_up_sector
      ON limit_up_record(sector_code, date);
    CREATE INDEX IF NOT EXISTS idx_daily_price_code_date
      ON stock_daily_price(stock_code, date);
    CREATE INDEX IF NOT EXISTS idx_index_price_symbol_date
      ON index_daily_price(symbol, date);
    CREATE INDEX IF NOT EXISTS idx_block_price_code_date
      ON block_daily_price(block_code, date);
    CREATE INDEX IF NOT EXISTS idx_block_price_code_period_date
      ON block_daily_price(block_code, period, date);
    CREATE INDEX IF NOT EXISTS idx_sector_trend_date
      ON sector_trend_daily(date);
    CREATE INDEX IF NOT EXISTS idx_ranking_factor_total
      ON ranking_factor(date, factor_name, val_numeric DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_ranking_date_score
      ON stock_ranking(date, total_score DESC);
  `);
  migrateV15(database);
  migrateV16(database);
  migrateV18(database);
  migrateV19(database);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}