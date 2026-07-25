import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnalysisData,
  BlockAnalysis,
  LimitUpStock,
  PaperStrategyInstruction,
  RankingResponse,
  RankingRow,
  StrategyAction,
} from '../src/types.js';
import type {
  HistoricalBar,
  HistoricalBlockSeries,
  HistoricalIndexSeries,
  HistoricalLimitUpRecord,
  HistoricalMarketData,
  HistoricalStockSeries,
  KLineData,
} from './historical-market.js';
import { formatDateTime, round } from './format.js';
import type { SectorTrendLookup } from './backtest-engine.js';
import {
  classifyMarketState,
  distanceFromLowScore,
  klinesToBars,
  volatilityClassOf,
  volatilityTrendScore,
  type TrendAxis,
} from './scoring-engine.js';

const SCHEMA_VERSION = 18;

export interface LimitUpRecord {
  date: string;
  stock_code: string;
  stock_name: string;
  sector_code: string;
  sector_name: string;
  continue_num: number;
  reason_type: string;
  sector_change: number;
  latest: number | null;
  change_rate: number | null;
}

export interface SectorTrendRecord {
  date: string;
  sector_code: string;
  sector_name: string;
  state_id: number;
  state_name: string;
  trend: string;
  latest: number | null;
  ma5: number | null;
  ma20: number | null;
  near_high: string;
  volume_trend: string;
  strategy_action: string;
  strategy_label: string;
  strategy_position: string;
  computed_at: string;
}

export interface DailyPriceCoverage {
  stock_code: string;
  stock_name: string;
  first_date: string;
  last_date: string;
  row_count: number;
}

export interface StoredDailyPrice extends KLineData {
  stock_code: string;
  stock_name: string;
}

export interface RankingFactorRecord {
  date: string;
  stock_code: string;
  factor_name: string;
  val_numeric: number | null;
  val_text: string;
}

function compactDate(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

function isoDate(value: unknown): string {
  const compact = compactDate(value);
  if (!compact) return '';
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

const STATE_NAMES: Record<number, string> = {
  0: '数据不足',
  1: '主线主升',
  2: '高位滞涨',
  3: '首次回调',
  4: '箱体震荡',
  5: '缩量无序',
  6: '阴跌不止',
  7: '恐慌暴跌',
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return finiteNumber(value) ?? fallback;
}

function textValue(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function stockMarket(code: string): string {
  if (/^(4|8|92)/.test(code)) return 'BJ';
  return /^(6|68|5|9)/.test(code) ? 'SH' : 'SZ';
}

function validStockCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

function normalizedSymbol(value: unknown): string {
  const symbol = String(value ?? '').trim().toLowerCase();
  return /^(sh|sz)\d{6}$/.test(symbol) ? symbol : '';
}

function strategyAction(value: unknown): StrategyAction {
  return ['accumulate', 'trade', 'reduce', 'ignore'].includes(String(value))
    ? value as StrategyAction
    : 'ignore';
}

function rowToKline(row: Record<string, unknown>): KLineData {
  const changeRate = finiteNumber(row.change_rate);
  return {
    date: textValue(row.date),
    open: numberValue(row.open),
    close: numberValue(row.close),
    high: numberValue(row.high),
    low: numberValue(row.low),
    volume: numberValue(row.volume),
    amount: numberValue(row.amount),
    ...(changeRate == null ? {} : { changeRate }),
  };
}

export class SqliteStore {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(root: string, filename = 'trending.db') {
    mkdirSync(root, { recursive: true });
    this.databasePath = path.join(root, filename);
    this.database = new DatabaseSync(this.databasePath, {
      enableForeignKeyConstraints: true,
    });
    this.initialize();
  }

  private initialize(): void {
    this.database.exec(`
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
        open REAL NOT NULL,
        close REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        volume REAL NOT NULL DEFAULT 0,
        amount REAL NOT NULL DEFAULT 0,
        change_rate REAL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (block_code, date)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS sector_trend_daily (
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
      CREATE INDEX IF NOT EXISTS idx_sector_trend_date
        ON sector_trend_daily(date);
      CREATE INDEX IF NOT EXISTS idx_ranking_factor_total
        ON ranking_factor(date, factor_name, val_numeric DESC);
      CREATE INDEX IF NOT EXISTS idx_stock_ranking_date_score
        ON stock_ranking(date, total_score DESC);

      `);
    this.migrateV15();
    this.migrateV16();
    this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  /** v16→17: 允许 state_id 为 0（数据不足），配合 CHECK 约束从 BETWEEN 1 AND 7 改为 0 AND 7。 */
  private migrateV16(): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    if (Number(version?.user_version ?? 0) >= 17) return;
    this.database.exec(`
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
      INSERT INTO sector_trend_daily_new SELECT * FROM sector_trend_daily;
      DROP TABLE sector_trend_daily;
      ALTER TABLE sector_trend_daily_new RENAME TO sector_trend_daily;
      -- 修复历史脏数据：state_name 与 state_id 不匹配的行
      UPDATE sector_trend_daily SET state_id = 0 WHERE state_name = '数据不足' AND state_id != 0;
      PRAGMA user_version = 17;
    `);
  }

  /** v15: 移除 limit_up_record 中的冗余名称列，改由 JOIN info 表获取。 */
  private migrateV15(): void {
    const columns = this.database.prepare(`PRAGMA table_info(limit_up_record)`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));
    if (names.has('stock_name')) {
      this.database.exec(`ALTER TABLE limit_up_record DROP COLUMN stock_name`);
    }
    if (names.has('sector_name')) {
      this.database.exec(`ALTER TABLE limit_up_record DROP COLUMN sector_name`);
    }
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original error if rollback itself fails.
      }
      throw error;
    }
  }

  private upsertStockInfo(code: string, name: string, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO stock_info (code, name, market, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE stock_info.name END,
        market = excluded.market,
        updated_at = excluded.updated_at
    `).run(code, name || code, stockMarket(code), timestamp, timestamp);
  }

  private upsertSectorInfo(code: string, name: string, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO sector_info (code, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE sector_info.name END,
        updated_at = excluded.updated_at
    `).run(code, name || code, timestamp, timestamp);
  }

  saveAnalysis(data: AnalysisData, requestedDate?: string): void {
    const date = compactDate(requestedDate || data.source_date || data.timestamp);
    if (!date) throw new Error('分析快照缺少有效日期，无法写入 SQLite');
    const computedAt = data.timestamp || formatDateTime();
    this.transaction(() => {
      this.database.prepare('DELETE FROM limit_up_record WHERE date = ?').run(date);
      this.database.prepare('DELETE FROM sector_trend_daily WHERE date = ?').run(date);
      const insertLimitUp = this.database.prepare(`
        INSERT INTO limit_up_record (
          date, stock_code, sector_code,
          continue_num, reason_type, sector_change, latest, change_rate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, stock_code) DO UPDATE SET
          sector_code = excluded.sector_code,
          continue_num = excluded.continue_num,
          reason_type = excluded.reason_type,
          sector_change = excluded.sector_change,
          latest = excluded.latest,
          change_rate = excluded.change_rate,
          created_at = excluded.created_at
      `);
      const insertTrend = this.database.prepare(`
        INSERT INTO sector_trend_daily (
          date, sector_code, sector_name, state_id, state_name, trend,
          latest, ma5, ma20, near_high, volume_trend,
          strategy_action, strategy_label, strategy_position, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, sector_code) DO UPDATE SET
          sector_name = excluded.sector_name,
          state_id = excluded.state_id,
          state_name = excluded.state_name,
          trend = excluded.trend,
          latest = excluded.latest,
          ma5 = excluded.ma5,
          ma20 = excluded.ma20,
          near_high = excluded.near_high,
          volume_trend = excluded.volume_trend,
          strategy_action = excluded.strategy_action,
          strategy_label = excluded.strategy_label,
          strategy_position = excluded.strategy_position,
          computed_at = excluded.computed_at
      `);
      const seenStocks = new Set<string>();
      for (const block of data.blocks ?? []) {
        const sectorCode = textValue(block.code).trim();
        const sectorName = textValue(block.name).trim();
        if (!sectorCode || !sectorName) continue;
        this.upsertSectorInfo(sectorCode, sectorName, computedAt);
        const stateId = Math.min(7, Math.max(0, Math.trunc(numberValue(block.trend?.state_id, 5))));
        const stateName = STATE_NAMES[stateId] ?? textValue(block.trend?.state_name);
        insertTrend.run(
          date,
          sectorCode,
          sectorName,
          stateId,
          stateName,
          textValue(block.trend?.trend),
          finiteNumber(block.trend?.latest),
          finiteNumber(block.trend?.ma5),
          finiteNumber(block.trend?.ma20),
          textValue(block.trend?.near_high),
          textValue(block.trend?.volume_trend),
          textValue(block.strategy?.action),
          textValue(block.strategy?.label),
          textValue(block.strategy?.position),
          computedAt,
        );
        for (const stock of block.stock_list ?? []) {
          const stockCode = textValue(stock.code).trim();
          const stockName = textValue(stock.name).trim();
          if (!validStockCode(stockCode) || !stockName || seenStocks.has(stockCode)) continue;
          seenStocks.add(stockCode);
          this.upsertStockInfo(stockCode, stockName, computedAt);
          const continueNum = Math.min(15, Math.max(1, Math.trunc(numberValue(stock.continue_num, 1))));
          insertLimitUp.run(
            date,
            stockCode,
            sectorCode,
            continueNum,
            textValue(stock.reason_type ?? stock.reason_info),
            numberValue(block.block_info?.change),
            finiteNumber(stock.latest),
            finiteNumber(stock.change_rate),
            computedAt,
          );
        }
      }
    });
  }

  loadAnalysis(): AnalysisData | null {
    const date = this.getLatestAnalysisDate();
    if (!date) return null;
    const trends = this.getSectorTrendsForDate(date);
    const limitUps = this.getLimitUpByDate(date);
    const trendBySector = new Map(trends.map((trend) => [trend.sector_code, trend]));
    const stocksBySector = new Map<string, LimitUpStock[]>();
    const sectorChange = new Map<string, number>();
    for (const record of limitUps) {
      const stocks = stocksBySector.get(record.sector_code) ?? [];
      stocks.push({
        code: record.stock_code,
        name: record.stock_name,
        continue_num: record.continue_num,
        reason_type: record.reason_type || null,
        latest: record.latest ?? undefined,
        change_rate: record.change_rate ?? undefined,
      });
      stocksBySector.set(record.sector_code, stocks);
      sectorChange.set(record.sector_code, record.sector_change);
    }
    const sectorCodes = [...new Set([...trendBySector.keys(), ...stocksBySector.keys()])].sort();
    const blocks: BlockAnalysis[] = sectorCodes.map((sectorCode) => {
      const trend = trendBySector.get(sectorCode);
      const stocks = stocksBySector.get(sectorCode) ?? [];
      const sectorName = trend?.sector_name
        ?? limitUps.find((record) => record.sector_code === sectorCode)?.sector_name
        ?? sectorCode;
      return {
        code: sectorCode,
        name: sectorName,
        block_info: {
          limit_up_num: stocks.length,
          change: sectorChange.get(sectorCode) ?? 0,
          max_continue: stocks.reduce((max, stock) => Math.max(max, Number(stock.continue_num ?? 1)), 0),
          stock_list: stocks,
        },
        trend: {
          state_id: trend?.state_id ?? 5,
          state_name: trend?.state_name ?? '缩量无序',
          trend: trend?.trend ?? '横盘',
          position: trend?.strategy_position ?? '0成',
          latest: trend?.latest ?? undefined,
          ma5: trend?.ma5,
          ma20: trend?.ma20,
          near_high: trend?.near_high,
          volume_trend: trend?.volume_trend,
        },
        strategy: {
          action: strategyAction(trend?.strategy_action),
          label: trend?.strategy_label ?? '休息',
          position: trend?.strategy_position ?? '0成',
        },
        stock_list: stocks,
      };
    });
    const totalLimitUp = limitUps.length;
    const timestamp = trends.map((trend) => trend.computed_at).sort().at(-1)
      ?? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} 00:00:00`;
    return {
      timestamp,
      source_date: date,
      indices: [],
      blocks,
      sentiment: {
        total_blocks: blocks.length,
        total_limit_up: totalLimitUp,
        sentiment: totalLimitUp >= 80 ? 'hot' : totalLimitUp >= 30 ? 'normal' : 'cold',
        hot_sectors: blocks.map((block) => block.name),
        top_3: [...blocks]
          .sort((left, right) => right.block_info.limit_up_num - left.block_info.limit_up_num)
          .slice(0, 3)
          .map((block) => ({
            name: block.name,
            code: block.code,
            limit_up_num: block.block_info.limit_up_num,
            change: block.block_info.change,
            max_continue: block.block_info.max_continue,
          })),
        continuous_boards: limitUps
          .filter((record) => record.continue_num >= 2)
          .map((record) => ({
            name: record.stock_name,
            code: record.stock_code,
            block: record.sector_name,
            continue_num: record.continue_num,
            reason_type: record.reason_type,
          })),
      },
    };
  }

  getLatestAnalysisDate(): string | null {
    const latest = this.database.prepare(`
      SELECT date FROM (
        SELECT date FROM sector_trend_daily
        UNION
        SELECT date FROM limit_up_record
      )
      ORDER BY date DESC
      LIMIT 1
    `).get();
    const date = compactDate(latest?.date);
    return date || null;
  }

  getLimitUpByDate(value: string): LimitUpRecord[] {
    const date = compactDate(value);
    if (!date) return [];
    return this.database.prepare(`
      SELECT r.date, r.stock_code, si.name AS stock_name,
             r.sector_code, sci.name AS sector_name,
             r.continue_num, r.reason_type, r.sector_change, r.latest, r.change_rate
      FROM limit_up_record r
      JOIN stock_info si ON si.code = r.stock_code
      JOIN sector_info sci ON sci.code = r.sector_code
      WHERE r.date = ?
      ORDER BY r.continue_num DESC, r.stock_code ASC
    `).all(date).map((row) => ({
      date: textValue(row.date),
      stock_code: textValue(row.stock_code),
      stock_name: textValue(row.stock_name),
      sector_code: textValue(row.sector_code),
      sector_name: textValue(row.sector_name),
      continue_num: numberValue(row.continue_num),
      reason_type: textValue(row.reason_type),
      sector_change: numberValue(row.sector_change),
      latest: finiteNumber(row.latest),
      change_rate: finiteNumber(row.change_rate),
    }));
  }

  getSectorStats(value: string): Array<{ sector_code: string; sector_name: string; limit_up_count: number; max_continue: number }> {
    const date = compactDate(value);
    if (!date) return [];
    return this.database.prepare(`
      SELECT r.sector_code, sci.name AS sector_name,
             COUNT(*) AS limit_up_count, MAX(r.continue_num) AS max_continue
      FROM limit_up_record r
      JOIN sector_info sci ON sci.code = r.sector_code
      WHERE r.date = ?
      GROUP BY r.sector_code
      ORDER BY limit_up_count DESC, r.sector_code ASC
    `).all(date).map((row) => ({
      sector_code: textValue(row.sector_code),
      sector_name: textValue(row.sector_name),
      limit_up_count: numberValue(row.limit_up_count),
      max_continue: numberValue(row.max_continue),
    }));
  }

  loadAllLimitUpCodes(): Array<{ date: string; stock_code: string }> {
    return this.database.prepare(`
      SELECT date, stock_code
      FROM limit_up_record
      ORDER BY date ASC, stock_code ASC
    `).all().map((row) => ({
      date: textValue(row.date),
      stock_code: textValue(row.stock_code),
    }));
  }

  /** 加载日期范围内的涨停记录（含板块代码），用于回测时跳过重复的 block_top 网络请求。 */
  loadLimitUpRecordsForDateRange(fromDate: string, toDate: string): HistoricalLimitUpRecord[] {
    const from = compactDate(fromDate);
    const to = compactDate(toDate);
    if (!from || !to) return [];
    return this.database.prepare(`
      SELECT r.date, r.stock_code, si.name AS stock_name,
             r.sector_code, sci.name AS sector_name,
             r.continue_num, r.reason_type, r.sector_change, r.latest, r.change_rate
      FROM limit_up_record r
      JOIN stock_info si ON si.code = r.stock_code
      JOIN sector_info sci ON sci.code = r.sector_code
      WHERE r.date BETWEEN ? AND ?
      ORDER BY r.date ASC, r.stock_code ASC
    `).all(from, to).map((row) => ({
      date: textValue(row.date),
      stock_code: textValue(row.stock_code),
      stock_name: textValue(row.stock_name),
      sector_code: textValue(row.sector_code),
      sector_name: textValue(row.sector_name),
      continue_num: numberValue(row.continue_num),
      reason_type: textValue(row.reason_type),
      sector_change: numberValue(row.sector_change),
      latest: finiteNumber(row.latest),
      change_rate: finiteNumber(row.change_rate),
    }));
  }

  getSectorTrendsForDate(value: string): SectorTrendRecord[] {
    const date = compactDate(value);
    if (!date) return [];
    return this.database.prepare(`
      SELECT * FROM sector_trend_daily
      WHERE date = ?
      ORDER BY sector_code ASC
    `).all(date).map((row) => ({
      date: textValue(row.date),
      sector_code: textValue(row.sector_code),
      sector_name: textValue(row.sector_name),
      state_id: numberValue(row.state_id),
      state_name: textValue(row.state_name),
      trend: textValue(row.trend),
      latest: finiteNumber(row.latest),
      ma5: finiteNumber(row.ma5),
      ma20: finiteNumber(row.ma20),
      near_high: textValue(row.near_high),
      volume_trend: textValue(row.volume_trend),
      strategy_action: textValue(row.strategy_action),
      strategy_label: textValue(row.strategy_label),
      strategy_position: textValue(row.strategy_position),
      computed_at: textValue(row.computed_at),
    }));
  }

  /**
   * 当 sector_trend_daily 缺少某板块的趋势数据时，从 block_daily_price 表
   * 中读取该板块的日线行情并实时计算趋势分类，作为兜底。
   * 返回 null 表示板块代码无效、数据不足或无法计算。
   */
  computeSectorTrendFromBlockPrices(sectorCode: string, date: string): SectorTrendLookup | null {
    if (!/^\d{6}$/.test(sectorCode)) return null;
    const targetDate = compactDate(date);
    if (!targetDate) return null;
    const blockPrices = this.getBlockPrices(sectorCode, 250)
      .filter((kline) => compactDate(kline.date) <= targetDate);
    if (blockPrices.length < 20) return null;
    const bars = klinesToBars(blockPrices);
    const state = classifyMarketState(bars);
    const sectorName = this.database.prepare(
      'SELECT name FROM sector_info WHERE code = ?',
    ).get(sectorCode);
    return {
      sector_code: sectorCode,
      sector_name: sectorName ? textValue(sectorName.name) : sectorCode,
      state_id: state.state_id,
      state_name: state.state_name,
    };
  }

  hasRankings(): boolean {
    const row = this.database.prepare('SELECT 1 AS found FROM ranking_snapshot LIMIT 1').get();
    return Boolean(row?.found);
  }

  private exactLimitUpCounts(asOfDate: string): Map<string, number> {
    // Build the lookback from observed trading dates, never from price changes
    // or only the dates on which a stock happened to hit limit-up.
    const dates = this.database.prepare(`
      SELECT date FROM (
        SELECT replace(date, '-', '') AS date
        FROM index_daily_price
        WHERE symbol = 'sh000001'
        UNION
        SELECT replace(date, '-', '') AS date
        FROM stock_daily_price
        UNION
        SELECT date
        FROM sector_trend_daily
      )
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT 20
    `).all(asOfDate).map((row) => compactDate(row.date)).filter(Boolean);
    if (!dates.length) return new Map();
    const placeholders = dates.map(() => '?').join(', ');
    const rows = this.database.prepare(`
      SELECT stock_code, COUNT(*) AS limit_up_count
      FROM limit_up_record
      WHERE date IN (${placeholders})
      GROUP BY stock_code
    `).all(...dates);
    return new Map(rows.map((row) => [textValue(row.stock_code), numberValue(row.limit_up_count)]));
  }

  private rankingTrendAxis(row: RankingRow): TrendAxis {
    const stateId = numberValue(row.sector_trend_state_id);
    if ([1, 2, 3].includes(stateId)) return 'up';
    if ([6, 7].includes(stateId)) return 'down';
    if (stateId === 4 || stateId === 5) return 'range';
    return row.alignment === 'bullish' ? 'up' : row.alignment === 'bearish' ? 'down' : 'range';
  }

  private normalizeRankingRow(row: RankingRow, exactLimitUpCount: number): RankingRow {
    const volatilityClass = volatilityClassOf(exactLimitUpCount);
    const volatilityScore = volatilityTrendScore(volatilityClass, this.rankingTrendAxis(row));
    const trendScore = numberValue(row.trend_score);
    const volumePriceScore = numberValue(row.volume_price_score ?? row.volume_score);
    const fromLow = distanceFromLowScore(numberValue(row.distance_from_low_pct));
    const positionScore = finiteNumber(row.position_score) ?? fromLow.score;
    const totalScore = round(trendScore + volumePriceScore + positionScore + volatilityScore, 1);
    return {
      ...row,
      total_score: totalScore,
      position_score: positionScore,
      position_label: row.position_label ?? fromLow.label,
      volatility_trend_score: volatilityScore,
      volatility_class: volatilityClass,
      volatility_label: ({ high: '高波动', medium: '中波动', low: '低波动' } as const)[volatilityClass],
      limit_up_count_20d: exactLimitUpCount,
    };
  }

  saveRanking(
    data: Pick<RankingResponse, 'timestamp' | 'date' | 'total_stocks' | 'rankings'>,
  ): Pick<RankingResponse, 'timestamp' | 'date' | 'total_stocks' | 'rankings'> {
    const date = compactDate(data.date);
    if (!date) throw new Error('排行榜缺少有效日期，无法写入 SQLite');
    const timestamp = data.timestamp || formatDateTime();
    const exactCounts = this.exactLimitUpCounts(date);
    const normalizedRankings: RankingRow[] = data.rankings
      .filter((row) => validStockCode(textValue(row.stock_code)) && Boolean(textValue(row.stock_name).trim()))
      .map((row) => this.normalizeRankingRow(row, exactCounts.get(row.stock_code) ?? 0))
      .sort((left, right) => numberValue(right.total_score) - numberValue(left.total_score)
        || numberValue(left.rank, Number.MAX_SAFE_INTEGER) - numberValue(right.rank, Number.MAX_SAFE_INTEGER)
        || left.stock_code.localeCompare(right.stock_code))
      .map((row, index): RankingRow => ({ ...row, rank: index + 1 }));
    this.transaction(() => {
      this.database.prepare('DELETE FROM ranking_factor WHERE date = ?').run(date);
      this.database.prepare('DELETE FROM stock_ranking WHERE date = ?').run(date);
      const insertRanking = this.database.prepare(`
        INSERT INTO stock_ranking (
          date, stock_code, stock_name, rank, total_score, trend_score,
          momentum_score, volume_score, volume_price_score, position_score,
          volatility_trend_score, alignment, trend_strength, volume_label,
          volume_price_label, position_label, volatility_class, volatility_label,
          limit_up_count_20d, sector_trend_name, sector_trend_state_id,
          latest_price,
          latest_change_rate, sector_code, sector_name, continue_num,
          reason_type, sector_change, payload_json, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);
      const insertFactor = this.database.prepare(`
        INSERT INTO ranking_factor (date, stock_code, factor_name, val_numeric, val_text)
        VALUES (?, ?, ?, ?, ?)
      `);
      let persisted = 0;
      for (const row of normalizedRankings) {
        const stockCode = textValue(row.stock_code).trim();
        const stockName = textValue(row.stock_name).trim();
        if (!validStockCode(stockCode) || !stockName) continue;
        const sectorCode = textValue(row.sector_code).trim();
        const sectorName = textValue(row.sector_name).trim();
        this.upsertStockInfo(stockCode, stockName, timestamp);
        if (sectorCode) this.upsertSectorInfo(sectorCode, sectorName || sectorCode, timestamp);
        persisted += 1;
        insertRanking.run(
          date,
          stockCode,
          stockName,
          Math.max(1, Math.trunc(numberValue(row.rank, persisted))),
          numberValue(row.total_score),
          numberValue(row.trend_score),
          finiteNumber(row.momentum_score),
          finiteNumber(row.volume_score),
          finiteNumber(row.volume_price_score),
          finiteNumber(row.position_score),
          finiteNumber(row.volatility_trend_score),
          textValue(row.alignment),
          finiteNumber(row.trend_strength),
          textValue(row.volume_label),
          textValue(row.volume_price_label),
          textValue(row.position_label),
          textValue(row.volatility_class),
          textValue(row.volatility_label),
          finiteNumber(row.limit_up_count_20d),
          textValue(row.sector_trend_name),
          finiteNumber(row.sector_trend_state_id),
          finiteNumber(row.latest_price),
          finiteNumber(row.latest_change_rate),
          sectorCode || null,
          sectorName,
          finiteNumber(row.continue_num),
          textValue(row.reason_type),
          finiteNumber(row.sector_change),
          JSON.stringify(row),
          timestamp,
        );
        for (const [factorName, value] of Object.entries(row)) {
          if (['rank', 'stock_code', 'stock_name'].includes(factorName) || value == null) continue;
          if (typeof value === 'number' && Number.isFinite(value)) {
            insertFactor.run(date, stockCode, factorName, value, '');
          } else if (typeof value === 'string') {
            insertFactor.run(date, stockCode, factorName, null, value);
          } else if (typeof value === 'boolean') {
            insertFactor.run(date, stockCode, factorName, value ? 1 : 0, '');
          }
        }
      }
      this.database.prepare(`
        INSERT INTO ranking_snapshot (date, timestamp, total_stocks, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          timestamp = excluded.timestamp,
          total_stocks = excluded.total_stocks,
          updated_at = excluded.updated_at
      `).run(date, timestamp, persisted, timestamp);
    });
    return {
      timestamp,
      date,
      total_stocks: normalizedRankings.length,
      rankings: normalizedRankings,
    };
  }

  private compatibilityRankingRows(date: string): Map<string, RankingRow> {
    const rows = this.database.prepare(`
      SELECT r.*, i.name AS info_name
      FROM stock_ranking r
      LEFT JOIN stock_info i ON i.code = r.stock_code
      WHERE r.date = ?
      ORDER BY r.rank ASC, r.stock_code ASC
    `).all(date);
    const result = new Map<string, RankingRow>();
    for (const row of rows) {
      const payload = parseJsonObject(row.payload_json);
      const stockCode = textValue(row.stock_code);
      result.set(stockCode, {
        ...payload,
        rank: numberValue(row.rank),
        stock_code: stockCode,
        stock_name: textValue(row.info_name || row.stock_name),
        total_score: numberValue(row.total_score),
        trend_score: numberValue(row.trend_score),
        momentum_score: finiteNumber(row.momentum_score) ?? undefined,
        volume_score: finiteNumber(row.volume_score) ?? undefined,
        volume_price_score: finiteNumber(row.volume_price_score) ?? undefined,
        position_score: finiteNumber(row.position_score) ?? undefined,
        volatility_trend_score: finiteNumber(row.volatility_trend_score) ?? undefined,
        alignment: textValue(row.alignment),
        trend_strength: finiteNumber(row.trend_strength) ?? undefined,
        volume_label: textValue(row.volume_label) || undefined,
        volume_price_label: textValue(row.volume_price_label) || undefined,
        position_label: textValue(row.position_label) || undefined,
        volatility_class: textValue(row.volatility_class) || undefined,
        volatility_label: textValue(row.volatility_label) || undefined,
        limit_up_count_20d: finiteNumber(row.limit_up_count_20d) ?? undefined,
        sector_trend_name: textValue(row.sector_trend_name) || undefined,
        sector_trend_state_id: finiteNumber(row.sector_trend_state_id) ?? undefined,
        latest_price: finiteNumber(row.latest_price),
        latest_change_rate: finiteNumber(row.latest_change_rate),
        sector_code: textValue(row.sector_code) || undefined,
        sector_name: textValue(row.sector_name) || undefined,
        continue_num: finiteNumber(row.continue_num) ?? undefined,
        reason_type: textValue(row.reason_type) || undefined,
      } as RankingRow);
    }
    return result;
  }

  loadRanking(dateValue?: string): Pick<RankingResponse, 'timestamp' | 'date' | 'total_stocks' | 'rankings'> | null {
    const requestedDate = compactDate(dateValue);
    const snapshot = requestedDate
      ? this.database.prepare('SELECT * FROM ranking_snapshot WHERE date = ?').get(requestedDate)
      : this.database.prepare('SELECT * FROM ranking_snapshot ORDER BY date DESC LIMIT 1').get();
    if (!snapshot) return null;
    const date = textValue(snapshot.date);
    const compatibility = this.compatibilityRankingRows(date);
    const factorRows = this.database.prepare(`
      SELECT date, stock_code, factor_name, val_numeric, val_text
      FROM ranking_factor
      WHERE date = ?
      ORDER BY stock_code ASC, factor_name ASC
    `).all(date);
    let rankings: RankingRow[];
    if (factorRows.length) {
      const byCode = new Map<string, RankingRow>();
      for (const factor of factorRows) {
        const stockCode = textValue(factor.stock_code);
        const row = byCode.get(stockCode) ?? compatibility.get(stockCode) ?? {
          rank: 0,
          stock_code: stockCode,
          stock_name: stockCode,
          total_score: 0,
          trend_score: 0,
          alignment: '',
        };
        const factorName = textValue(factor.factor_name);
        const numeric = finiteNumber(factor.val_numeric);
        row[factorName] = numeric == null ? textValue(factor.val_text) : numeric;
        byCode.set(stockCode, row);
      }
      rankings = [...byCode.values()]
        .sort((left, right) => numberValue(right.total_score) - numberValue(left.total_score)
          || numberValue(left.rank, Number.MAX_SAFE_INTEGER) - numberValue(right.rank, Number.MAX_SAFE_INTEGER)
          || left.stock_code.localeCompare(right.stock_code))
        .map((row, index) => ({ ...row, rank: index + 1 }));
    } else {
      rankings = [...compatibility.values()];
    }
    return {
      timestamp: textValue(snapshot.timestamp),
      date,
      total_stocks: rankings.length || numberValue(snapshot.total_stocks),
      rankings,
    };
  }

  getRankingFactorsForDate(value: string): RankingFactorRecord[] {
    const date = compactDate(value);
    if (!date) return [];
    return this.database.prepare(`
      SELECT date, stock_code, factor_name, val_numeric, val_text
      FROM ranking_factor
      WHERE date = ?
      ORDER BY stock_code ASC, factor_name ASC
    `).all(date).map((row) => ({
      date: textValue(row.date),
      stock_code: textValue(row.stock_code),
      factor_name: textValue(row.factor_name),
      val_numeric: finiteNumber(row.val_numeric),
      val_text: textValue(row.val_text),
    }));
  }

  clearRankingData(): void {
    this.transaction(() => {
      this.database.exec('DELETE FROM ranking_factor; DELETE FROM stock_ranking; DELETE FROM ranking_snapshot;');
      this.database.exec('DROP TABLE IF EXISTS ranking_intermediate;');
    });
  }

  private upsertStockPricesWithinTransaction(stockCode: string, stockName: string, klines: KLineData[], timestamp: string): number {
    if (!validStockCode(stockCode)) return 0;
    this.upsertStockInfo(stockCode, stockName || stockCode, timestamp);
    const statement = this.database.prepare(`
      INSERT INTO stock_daily_price (
        stock_code, stock_name, date, open, close, high, low,
        volume, amount, change_rate, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stock_code, date) DO UPDATE SET
        stock_name = excluded.stock_name,
        open = excluded.open,
        close = excluded.close,
        high = excluded.high,
        low = excluded.low,
        volume = excluded.volume,
        amount = excluded.amount,
        change_rate = excluded.change_rate,
        created_at = excluded.created_at
    `);
    let count = 0;
    for (const kline of klines) {
      const date = isoDate(kline.date);
      if (!date || ![kline.open, kline.close, kline.high, kline.low].every((value) => Number.isFinite(value) && value > 0)) continue;
      statement.run(
        stockCode,
        stockName || stockCode,
        date,
        kline.open,
        kline.close,
        kline.high,
        kline.low,
        Number.isFinite(kline.volume) ? kline.volume : 0,
        Number.isFinite(kline.amount) ? kline.amount : 0,
        finiteNumber(kline.changeRate),
        timestamp,
      );
      count += 1;
    }
    return count;
  }

  upsertStockPrices(stockCode: string, stockName: string, klines: KLineData[]): number {
    const timestamp = formatDateTime();
    return this.transaction(() => this.upsertStockPricesWithinTransaction(stockCode, stockName, klines, timestamp));
  }

  getStockPrices(stockCode: string, limit = 120): KLineData[] {
    if (!validStockCode(stockCode)) return [];
    const boundedLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    return this.database.prepare(`
      SELECT date, open, close, high, low, volume, amount, change_rate
      FROM (
        SELECT date, open, close, high, low, volume, amount, change_rate
        FROM stock_daily_price
        WHERE stock_code = ?
        ORDER BY date DESC
        LIMIT ?
      )
      ORDER BY date ASC
    `).all(stockCode, boundedLimit).map((row) => rowToKline(row));
  }

  getStockName(stockCode: string): string | null {
    if (!validStockCode(stockCode)) return null;
    const row = this.database.prepare('SELECT name FROM stock_info WHERE code = ?').get(stockCode);
    return row ? textValue(row.name) : null;
  }

  private upsertIndexPricesWithinTransaction(symbolValue: string, indexName: string, klines: KLineData[], timestamp: string): number {
    const symbol = normalizedSymbol(symbolValue);
    if (!symbol) return 0;
    const statement = this.database.prepare(`
      INSERT INTO index_daily_price (
        symbol, index_name, date, open, close, high, low,
        volume, amount, change_rate, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        index_name = excluded.index_name,
        open = excluded.open,
        close = excluded.close,
        high = excluded.high,
        low = excluded.low,
        volume = excluded.volume,
        amount = excluded.amount,
        change_rate = excluded.change_rate,
        created_at = excluded.created_at
    `);
    let count = 0;
    for (const kline of klines) {
      const date = isoDate(kline.date);
      if (!date || ![kline.open, kline.close, kline.high, kline.low].every((value) => Number.isFinite(value) && value > 0)) continue;
      statement.run(
        symbol,
        indexName || symbol,
        date,
        kline.open,
        kline.close,
        kline.high,
        kline.low,
        Number.isFinite(kline.volume) ? kline.volume : 0,
        Number.isFinite(kline.amount) ? kline.amount : 0,
        finiteNumber(kline.changeRate),
        timestamp,
      );
      count += 1;
    }
    return count;
  }

  upsertIndexPrices(symbol: string, indexName: string, klines: KLineData[]): number {
    const timestamp = formatDateTime();
    return this.transaction(() => this.upsertIndexPricesWithinTransaction(symbol, indexName, klines, timestamp));
  }

  getIndexPrices(symbolValue: string, limit = 120): KLineData[] {
    const symbol = normalizedSymbol(symbolValue);
    if (!symbol) return [];
    const boundedLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    return this.database.prepare(`
      SELECT date, open, close, high, low, volume, amount, change_rate
      FROM (
        SELECT date, open, close, high, low, volume, amount, change_rate
        FROM index_daily_price
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
      )
      ORDER BY date ASC
    `).all(symbol, boundedLimit).map((row) => rowToKline(row));
  }

  getIndexTradingDays(symbolValue: string): string[] {
    const symbol = normalizedSymbol(symbolValue);
    if (!symbol) return [];
    return this.database.prepare(`
      SELECT date FROM index_daily_price
      WHERE symbol = ?
      ORDER BY date ASC
    `).all(symbol).map((row) => compactDate(row.date)).filter(Boolean);
  }

  private upsertBlockPricesWithinTransaction(blockCode: string, blockName: string, klines: KLineData[], timestamp: string): number {
    if (!/^\d{6}$/.test(blockCode)) return 0;
    this.upsertSectorInfo(blockCode, blockName || blockCode, timestamp);
    const statement = this.database.prepare(`
      INSERT INTO block_daily_price (
        block_code, block_name, date, open, close, high, low,
        volume, amount, change_rate, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(block_code, date) DO UPDATE SET
        block_name = excluded.block_name,
        open = excluded.open,
        close = excluded.close,
        high = excluded.high,
        low = excluded.low,
        volume = excluded.volume,
        amount = excluded.amount,
        change_rate = excluded.change_rate,
        created_at = excluded.created_at
    `);
    let count = 0;
    for (const kline of klines) {
      const date = isoDate(kline.date);
      if (!date || ![kline.open, kline.close, kline.high, kline.low].every((v) => Number.isFinite(v) && v > 0)) continue;
      statement.run(
        blockCode,
        blockName || blockCode,
        date,
        kline.open,
        kline.close,
        kline.high,
        kline.low,
        Number.isFinite(kline.volume) ? kline.volume : 0,
        Number.isFinite(kline.amount) ? kline.amount : 0,
        finiteNumber(kline.changeRate),
        timestamp,
      );
      count += 1;
    }
    return count;
  }

  upsertBlockPrices(blockCode: string, blockName: string, klines: KLineData[]): number {
    const timestamp = formatDateTime();
    return this.transaction(() => this.upsertBlockPricesWithinTransaction(blockCode, blockName, klines, timestamp));
  }

  getBlockPrices(blockCode: string, limit = 250): KLineData[] {
    if (!/^\d{6}$/.test(blockCode)) return [];
    const boundedLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
    return this.database.prepare(`
      SELECT date, open, close, high, low, volume, amount, change_rate
      FROM (
        SELECT date, open, close, high, low, volume, amount, change_rate
        FROM block_daily_price
        WHERE block_code = ?
        ORDER BY date DESC
        LIMIT ?
      )
      ORDER BY date ASC
    `).all(blockCode, boundedLimit).map((row) => rowToKline(row));
  }

  getAllStockPriceCoverage(dateFrom: string, dateTo: string): DailyPriceCoverage[] {
    const from = isoDate(dateFrom);
    const to = isoDate(dateTo);
    if (!from || !to) return [];
    return this.database.prepare(`
      SELECT stock_code, MAX(stock_name) AS stock_name,
             MIN(date) AS first_date, MAX(date) AS last_date,
             COUNT(*) AS row_count
      FROM stock_daily_price
      WHERE date BETWEEN ? AND ?
      GROUP BY stock_code
      ORDER BY stock_code ASC
    `).all(from, to).map((row) => ({
      stock_code: textValue(row.stock_code),
      stock_name: textValue(row.stock_name),
      first_date: textValue(row.first_date),
      last_date: textValue(row.last_date),
      row_count: numberValue(row.row_count),
    }));
  }

  loadAllDailyPrices(): StoredDailyPrice[] {
    return this.database.prepare(`
      SELECT stock_code, stock_name, date, open, close, high, low,
             volume, amount, change_rate
      FROM stock_daily_price
      ORDER BY stock_code ASC, date ASC
    `).all().map((row) => ({
      stock_code: textValue(row.stock_code),
      stock_name: textValue(row.stock_name),
      ...rowToKline(row),
    }));
  }

  saveHistoricalMarket(data: HistoricalMarketData): void {
    const timestamp = data.generated_at || formatDateTime();
    const calendar = [...new Set(data.calendar.map(compactDate).filter(Boolean))].sort();
    const stockCodes: string[] = [];
    const indexSymbols: string[] = [];
    this.transaction(() => {
      for (const stock of data.stocks) {
        if (!validStockCode(stock.stock_code)) continue;
        const klines = stock.bars.map((bar) => ({
          date: bar[0],
          open: bar[1],
          close: bar[2],
          high: bar[3],
          low: bar[4],
          volume: bar[5],
          amount: bar[6],
          changeRate: bar[7],
        }));
        this.upsertStockPricesWithinTransaction(stock.stock_code, stock.stock_name, klines, timestamp);
        stockCodes.push(stock.stock_code);
      }
      for (const index of data.indices ?? []) {
        const symbol = normalizedSymbol(index.symbol);
        if (!symbol) continue;
        const klines = index.bars.map((bar) => ({
          date: bar[0],
          open: bar[1],
          close: bar[2],
          high: bar[3],
          low: bar[4],
          volume: bar[5],
          amount: bar[6],
          changeRate: bar[7],
        }));
        this.upsertIndexPricesWithinTransaction(symbol, index.index_name, klines, timestamp);
        indexSymbols.push(symbol);
      }
      for (const block of data.blocks ?? []) {
        if (!/^\d{6}$/.test(block.block_code)) continue;
        const klines = block.bars.map((bar) => ({
          date: bar[0],
          open: bar[1],
          close: bar[2],
          high: bar[3],
          low: bar[4],
          volume: bar[5],
          amount: bar[6],
          changeRate: bar[7],
        }));
        this.upsertBlockPricesWithinTransaction(block.block_code, block.block_name, klines, timestamp);
      }
      this.database.prepare(`
        INSERT INTO historical_snapshot (
          singleton, schema_version, source, generated_at, as_of_date,
          universe_as_of_date, requested_days, warmup_days, calendar_json,
          stock_codes_json, index_symbols_json, failed_stocks, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          schema_version = excluded.schema_version,
          source = excluded.source,
          generated_at = excluded.generated_at,
          as_of_date = excluded.as_of_date,
          universe_as_of_date = excluded.universe_as_of_date,
          requested_days = excluded.requested_days,
          warmup_days = excluded.warmup_days,
          calendar_json = excluded.calendar_json,
          stock_codes_json = excluded.stock_codes_json,
          index_symbols_json = excluded.index_symbols_json,
          failed_stocks = excluded.failed_stocks,
          updated_at = excluded.updated_at
      `).run(
        data.schema_version,
        data.source,
        timestamp,
        compactDate(data.as_of_date),
        compactDate(data.universe_as_of_date),
        data.requested_days,
        data.warmup_days,
        JSON.stringify(calendar),
        JSON.stringify([...new Set(stockCodes)].sort()),
        JSON.stringify([...new Set(indexSymbols)].sort()),
        data.failed_stocks,
        timestamp,
      );
      // 持久化历史涨停记录（不覆盖已有记录）
      if (data.limit_up_records?.length) {
        const insertLimitUpHistory = this.database.prepare(`
          INSERT INTO limit_up_record (
            date, stock_code, sector_code,
            continue_num, reason_type, sector_change, latest, change_rate, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(date, stock_code) DO UPDATE SET
            sector_code = CASE WHEN limit_up_record.sector_code = 'UNKNOWN' THEN excluded.sector_code ELSE limit_up_record.sector_code END,
            continue_num = excluded.continue_num,
            reason_type = CASE WHEN limit_up_record.reason_type = '' THEN excluded.reason_type ELSE limit_up_record.reason_type END,
            sector_change = excluded.sector_change,
            latest = excluded.latest,
            change_rate = excluded.change_rate
        `);
        for (const record of data.limit_up_records) {
          const stockCode = record.stock_code;
          const sectorCode = record.sector_code || 'UNKNOWN';
          this.upsertStockInfo(stockCode, record.stock_name || stockCode, timestamp);
          this.upsertSectorInfo(sectorCode, record.sector_name || sectorCode, timestamp);
          insertLimitUpHistory.run(
            compactDate(record.date),
            stockCode,
            sectorCode,
            Math.min(15, Math.max(1, Math.trunc(record.continue_num ?? 1))),
            record.reason_type ?? '',
            record.sector_change ?? 0,
            record.latest ?? null,
            record.change_rate ?? null,
            timestamp,
          );
        }
      }
    });
  }

  loadHistoricalMarket(): HistoricalMarketData | null {
    const snapshot = this.database.prepare('SELECT * FROM historical_snapshot WHERE singleton = 1').get();
    if (!snapshot) return null;
    const calendar = parseJsonArray<string>(snapshot.calendar_json).map(compactDate).filter(Boolean).sort();
    const firstDate = isoDate(calendar[0] ?? snapshot.as_of_date);
    const lastDate = isoDate(snapshot.as_of_date);
    const stockCodes = parseJsonArray<string>(snapshot.stock_codes_json).filter(validStockCode);
    const stockStatement = this.database.prepare(`
      SELECT p.stock_code, p.stock_name, p.date, p.open, p.close, p.high, p.low,
             p.volume, p.amount, p.change_rate, i.name AS info_name
      FROM stock_daily_price p
      LEFT JOIN stock_info i ON i.code = p.stock_code
      WHERE p.stock_code = ? AND p.date BETWEEN ? AND ?
      ORDER BY p.date ASC
    `);
    const stocks: HistoricalStockSeries[] = [];
    for (const stockCode of stockCodes) {
      const rows = stockStatement.all(stockCode, firstDate, lastDate);
      if (!rows.length) continue;
      const bars = rows.map((row): HistoricalBar => [
        compactDate(row.date),
        numberValue(row.open),
        numberValue(row.close),
        numberValue(row.high),
        numberValue(row.low),
        numberValue(row.volume),
        numberValue(row.amount),
        numberValue(row.change_rate),
      ]);
      stocks.push({
        stock_code: stockCode,
        stock_name: textValue(rows[0].info_name || rows[0].stock_name, stockCode),
        bars,
      });
    }
    const indices: HistoricalIndexSeries[] = [];
    for (const symbol of parseJsonArray<string>(snapshot.index_symbols_json).map(normalizedSymbol).filter(Boolean)) {
      const rows = this.database.prepare(`
        SELECT symbol, index_name, date, open, close, high, low,
               volume, amount, change_rate
        FROM index_daily_price
        WHERE symbol = ? AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(symbol, firstDate, lastDate);
      if (!rows.length) continue;
      indices.push({
        symbol,
        index_name: textValue(rows[0].index_name, symbol),
        bars: rows.map((row): HistoricalBar => [
          compactDate(row.date),
          numberValue(row.open),
          numberValue(row.close),
          numberValue(row.high),
          numberValue(row.low),
          numberValue(row.volume),
          numberValue(row.amount),
          numberValue(row.change_rate),
        ]),
      });
    }
    const source = textValue(snapshot.source) === 'eastmoney-unadjusted'
      ? 'eastmoney-unadjusted' as const
      : 'multi-source-qfq' as const;
    const firstCompactDate = compactDate(calendar[0] ?? snapshot.as_of_date);
    const lastCompactDate = compactDate(snapshot.as_of_date);
    const limitUpRecords = this.database.prepare(`
      SELECT date, stock_code, sector_code
      FROM limit_up_record
      WHERE date BETWEEN ? AND ?
      ORDER BY date ASC, stock_code ASC
    `).all(firstCompactDate, lastCompactDate).map((row) => ({
      date: textValue(row.date),
      stock_code: textValue(row.stock_code),
      sector_code: textValue(row.sector_code),
    }));
    // 加载板块K线（从 limit_up_record 中获取出现过的板块代码）
    const blockCodes = this.database.prepare(`
      SELECT DISTINCT sector_code FROM limit_up_record
      WHERE date BETWEEN ? AND ? AND sector_code != 'UNKNOWN'
    `).all(firstCompactDate, lastCompactDate).map((row) => textValue(row.sector_code));
    const blocks: HistoricalBlockSeries[] = [];
    for (const blockCode of blockCodes) {
      const rows = this.database.prepare(`
        SELECT block_code, block_name, date, open, close, high, low,
               volume, amount, change_rate
        FROM block_daily_price
        WHERE block_code = ? AND date BETWEEN ? AND ?
        ORDER BY date ASC
      `).all(blockCode, firstDate, lastDate);
      if (!rows.length) continue;
      blocks.push({
        block_code: blockCode,
        block_name: textValue(rows[0].block_name, blockCode),
        bars: rows.map((row): HistoricalBar => [
          compactDate(row.date),
          numberValue(row.open),
          numberValue(row.close),
          numberValue(row.high),
          numberValue(row.low),
          numberValue(row.volume),
          numberValue(row.amount),
          numberValue(row.change_rate),
        ]),
      });
    }
    return {
      schema_version: 1,
      source,
      generated_at: textValue(snapshot.generated_at),
      as_of_date: compactDate(snapshot.as_of_date),
      universe_as_of_date: compactDate(snapshot.universe_as_of_date),
      requested_days: numberValue(snapshot.requested_days),
      warmup_days: numberValue(snapshot.warmup_days),
      calendar,
      stocks,
      indices,
      blocks: blocks.length ? blocks : undefined,
      limit_up_records: limitUpRecords,
      failed_stocks: numberValue(snapshot.failed_stocks),
    };
  }

  loadInstructions(): PaperStrategyInstruction[] {
    return this.database.prepare(`
      SELECT i.id, i.side, i.stock_code, si.name AS stock_name,
             i.signal_date, i.signal_price, i.quantity, i.rank,
             i.reason, i.execution_window,
             i.status, i.created_at, i.submitted_at, i.completed_at,
             i.broker_status, i.execution_price
      FROM paper_instruction i
      JOIN stock_info si ON si.code = i.stock_code
      ORDER BY i.created_at ASC
    `).all().map((row) => ({
      id: textValue(row.id),
      side: textValue(row.side) as 'buy' | 'sell',
      stock_code: textValue(row.stock_code),
      stock_name: textValue(row.stock_name),
      signal_date: textValue(row.signal_date),
      signal_price: numberValue(row.signal_price),
      quantity: numberValue(row.quantity),
      ...(row.rank != null ? { rank: numberValue(row.rank) } : {}),
      reason: textValue(row.reason),
      ...(row.execution_window != null ? { execution_window: textValue(row.execution_window) as 'open' | 'near_close' } : {}),
      status: textValue(row.status) as PaperStrategyInstruction['status'],
      created_at: textValue(row.created_at),
      ...(row.submitted_at != null ? { submitted_at: textValue(row.submitted_at) } : {}),
      ...(row.completed_at != null ? { completed_at: textValue(row.completed_at) } : {}),
      ...(row.broker_status != null ? { broker_status: textValue(row.broker_status) } : {}),
      ...(row.execution_price != null ? { execution_price: numberValue(row.execution_price) } : {}),
    }));
  }

  saveInstructions(instructions: PaperStrategyInstruction[]): void {
    this.transaction(() => {
      this.database.prepare('DELETE FROM paper_instruction').run();
      const insert = this.database.prepare(`
        INSERT INTO paper_instruction (
          id, side, stock_code, signal_date, signal_price, quantity,
          rank, reason, execution_window,
          status, created_at, submitted_at, completed_at, broker_status, execution_price
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const inst of instructions) {
        this.upsertStockInfo(inst.stock_code, inst.stock_name || inst.stock_code, inst.created_at);
        insert.run(
          inst.id,
          inst.side,
          inst.stock_code,
          inst.signal_date,
          inst.signal_price,
          inst.quantity,
          inst.rank ?? null,
          inst.reason ?? '',
          inst.execution_window ?? null,
          inst.status,
          inst.created_at,
          inst.submitted_at ?? null,
          inst.completed_at ?? null,
          inst.broker_status ?? null,
          inst.execution_price ?? null,
        );
      }
    });
  }

  storageStatus(): {
    database_path: string;
    journal_mode: string;
    foreign_keys: boolean;
    busy_timeout_ms: number;
    synchronous: string;
    schema_version: number;
    tables: string[];
  } {
    const journal = this.database.prepare('PRAGMA journal_mode').get();
    const foreignKeys = this.database.prepare('PRAGMA foreign_keys').get();
    const busyTimeout = this.database.prepare('PRAGMA busy_timeout').get();
    const synchronous = this.database.prepare('PRAGMA synchronous').get();
    const version = this.database.prepare('PRAGMA user_version').get();
    const tables = this.database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all().map((row) => textValue(row.name));
    return {
      database_path: this.databasePath,
      journal_mode: textValue(journal?.journal_mode),
      foreign_keys: numberValue(foreignKeys?.foreign_keys) === 1,
      busy_timeout_ms: numberValue(busyTimeout?.timeout),
      synchronous: ['off', 'normal', 'full', 'extra'][numberValue(synchronous?.synchronous)] ?? 'unknown',
      schema_version: numberValue(version?.user_version),
      tables,
    };
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
