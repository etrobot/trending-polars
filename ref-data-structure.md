# 数据层设计文档

> **Node 实现约束**：项目使用 Node.js 22.13+ 内置的 `node:sqlite`（`DatabaseSync`），数据库位于 `server/data/trending.db`。`server/data/` 整体加入 `.gitignore`，仓库和 Git 历史不保存行情、排行、账户状态或回测数据。

## 1. 数据存储架构

Trending 采用**多层级存储**策略，根据数据特性选择最优存储方案：

```
┌──────────────────────────────────────────────────────────┐
│                    SQLite 数据库                          │
│  - 结构化数据：股票/板块/涨停记录/行情/排行榜因子          │
│  - WAL 模式，支持并发读写                                │
│  - 外键约束，保证数据一致性                              │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                    JSON 缓存文件                          │
│  - runtime/analysis.json: 指数与聚合字段缓存              │
│  - runtime/ranking.json: 最新排行榜缓存                   │
│  - runtime/backtests/: 回测结果 JSON 归档                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                    内存缓存                               │
│  - TaskRegistry: 任务状态快照                             │
│  - 回测预加载: SQLite 行情/涨停字典                       │
└──────────────────────────────────────────────────────────┘
```

## 2. 数据库表结构设计

### 2.1 表结构总览

```sql
-- 股票信息表
stock_info (code, name, market, created_at, updated_at)

-- 板块信息表
sector_info (code, name, created_at, updated_at)

-- 涨停记录表
limit_up_record (date, stock_code, stock_name, sector_code, sector_name,
                 continue_num, reason_type, sector_change, latest, change_rate, created_at)

-- 股票行情表
stock_daily_price (stock_code, stock_name, date, open, close, high, low,
                   volume, amount, change_rate, created_at)

-- 指数行情表（独立于个股）
index_daily_price (symbol, index_name, date, open, close, high, low,
                   volume, amount, change_rate, created_at)

-- 板块每日趋势判读表
sector_trend_daily (date, sector_code, sector_name, state_id, state_name,
                    trend, latest, ma5, ma20, near_high, volume_trend,
                    strategy_action, strategy_label, strategy_position, computed_at)

-- 排行榜因子表（灵活 KV 存储）
ranking_factor (date, stock_code, factor_name, val_numeric, val_text)

-- 排行榜表（向下兼容）
stock_ranking (date, stock_code, stock_name, rank, total_score,
               trend_score, momentum_score, volume_score, position_score,
               alignment, trend_strength, volume_label, position_label,
               strategy_action, strategy_label, strategy_position,
               latest_price, latest_change_rate, sector_code, sector_name,
               continue_num, reason_type, sector_change)

-- 最新排行榜与历史行情快照元数据
ranking_snapshot (date, timestamp, total_stocks, updated_at)
historical_snapshot (singleton, schema_version, source, generated_at, as_of_date,
                     universe_as_of_date, requested_days, warmup_days,
                     calendar_json, stock_codes_json, index_symbols_json,
                     failed_stocks, updated_at)
```

### 2.2 表关系图

```
┌─────────────────┐
│   stock_info    │
│  (股票基础信息)  │
└────────┬────────┘
         │ code
         ├──────────────────────────────┐
         │                              │
         ↓                              ↓
┌─────────────────┐           ┌─────────────────┐
│stock_daily_price│           │ limit_up_record │
│  (个股日行情)    │           │  (涨停记录)      │
└─────────────────┘           └────────┬────────┘
                                       │ sector_code
                                       ↓
                              ┌─────────────────┐
                              │   sector_info   │
                              │ (板块基础信息)   │
                              └────────┬────────┘
                                       │ code
         ┌─────────────────────────────┼──────────────────┐
         │                             │                  │
         ↓                             ↓                  ↓
┌─────────────────┐         ┌─────────────────┐  ┌─────────────────┐
│sector_trend_daily│         │ ranking_factor  │  │ stock_ranking   │
│ (板块趋势判读)   │         │ (排行榜因子KV)  │  │ (排行榜冗余表)  │
└─────────────────┘         └─────────────────┘  └─────────────────┘
```

## 3. 核心表设计详解

### 3.1 涨停记录表 (limit_up_record)

**设计目标**：记录每日涨停个股信息，支持历史回测

**权威来源约束**：记录只能来自同花顺 `dataapi/limit_up/block_top` 的 `stock_list`。禁止根据日涨幅、股票代码板块、ST 标识或理论涨停价生成涨停记录；缺少 block_top 数据时保持未知，不做价格补判。

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| date | TEXT | 日期 YYYYMMDD |
| stock_code | TEXT | 股票代码（6位） |
| stock_name | TEXT | 股票名称 |
| sector_code | TEXT | 板块代码 |
| sector_name | TEXT | 板块名称 |
| continue_num | INTEGER | 连板数（1-15） |
| reason_type | TEXT | 涨停原因 |
| sector_change | REAL | 板块涨幅 |
| latest | REAL | block_top 返回的最新价，可空 |
| change_rate | REAL | block_top 返回的涨幅，可空；不用于反推涨停 |

**索引设计**：
```sql
CREATE INDEX idx_limit_up_date ON limit_up_record(date);
CREATE INDEX idx_limit_up_sector ON limit_up_record(sector_code, date);
PRIMARY KEY (date, stock_code);  -- WITHOUT ROWID，防止重复
```

**使用场景**：
- 按日期查询涨停记录：`get_limit_up_by_date(date)`
- 按板块统计涨停数：`get_sector_stats(date)`
- 回测加载全部涨停：`load_all_limit_up_codes()`

### 3.2 股票行情表 (stock_daily_price)

**设计目标**：存储个股日 K 线数据，支持技术指标计算

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| stock_code | TEXT | 股票代码 |
| stock_name | TEXT | 股票名称 |
| date | TEXT | 日期 YYYY-MM-DD |
| open/close/high/low | REAL | 开高低收 |
| volume | REAL | 成交量 |
| amount | REAL | 成交额 |
| change_rate | REAL | 涨跌幅 |

**索引设计**：
```sql
CREATE INDEX idx_daily_price_code_date ON stock_daily_price(stock_code, date);
PRIMARY KEY (stock_code, date);  -- WITHOUT ROWID，防止重复
```

**性能优化**：
- 批量 upsert：`upsert_daily_prices(rows)` 单次连接写入多条
- 区间覆盖检查：`get_all_stock_price_coverage(date_from, date_to)` 一次 GROUP BY
- 全量加载：`loadAllDailyPrices()` 使用单条 SQL 批量读取并构建 Node 内存数组

### 3.3 指数行情表 (index_daily_price)

**设计目标**：独立存储指数日 K 线，避免与个股代码冲突

**设计背景**：
- 上证指数代码 `sh000001`，与平安银行 `000001` 冲突
- 指数使用带市场前缀的 symbol（如 sh000001）作为主键
- 与个股行情解耦，独立管理

**使用场景**：
- 交易日历：`get_index_trading_days(symbol)` 获取交易日列表
- 自愈回填：本地交易日历不足时自动拉取历史
- 回测指数分析：提供大盘环境参考

### 3.4 板块趋势判读表 (sector_trend_daily)

**设计目标**：缓存板块趋势计算结果，避免回测重复计算

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| date | TEXT | 日期 |
| sector_code | TEXT | 板块代码 |
| state_id | INTEGER | 状态ID（1-7） |
| state_name | TEXT | 状态名称（上升/滞涨/回调/震荡/弱势/阴跌/暴跌） |
| trend | TEXT | 趋势方向 |
| latest/ma5/ma20 | REAL | 价格与均线 |
| near_high | TEXT | 距高点距离 |
| volume_trend | TEXT | 成交量趋势 |
| strategy_action/label/position | TEXT | 策略建议 |

**缓存策略**：
```typescript
const cached = await store.getSectorTrendsForDate(date);
if (!cached.length) {
  const daily = await fetchBlockKlines(sectorCode, '01', 250);
  const weekly = await fetchBlockKlines(sectorCode, '11', 120);
  const monthly = await fetchBlockKlines(sectorCode, '21', 120);
  const trend = analyzeBlockTrend(
    klinesToBars(daily.klines),
    klinesToBars(weekly.klines),
    klinesToBars(monthly.klines),
  );
  // saveAnalysis() 在同一事务中写入 sector_trend_daily 和 limit_up_record。
}
```

**性能提升**：
- 首跑：计算 + 落库
- 后续回测：直接读库，零计算零网络

### 3.5 排行榜因子表 (ranking_factor)

**设计目标**：灵活 KV 存储，支持快速迭代新因子

**核心设计**：
```sql
CREATE TABLE ranking_factor (
    date        TEXT NOT NULL,
    stock_code  TEXT NOT NULL,
    factor_name TEXT NOT NULL,
    val_numeric REAL,          -- 数值型因子
    val_text    TEXT DEFAULT '', -- 标签型因子
    PRIMARY KEY (date, stock_code, factor_name)
)
```

**因子类型**：
| 因子名称 | 类型 | 说明 |
|---------|------|------|
| total_score | numeric | 总评分（满分100） |
| trend_score | numeric | K线趋势评分（40分） |
| volume_price_score | numeric | 价量配合评分（25分） |
| position_score | numeric | 价格位置评分（20分） |
| volatility_trend_score | numeric | 波动率适配评分（15分） |
| limit_up_count_20d | numeric | 最近20个交易日 block_top 权威涨停次数 |
| alignment | text | 均线排列（bullish/bearish/tangled） |
| volume_price_label | text | 价量配合标签 |
| sector_trend_name | text | 板块趋势状态名 |

**优势**：
- 新增因子无需改表结构，只需写入新 factor_name
- rank 不存储，读取时按 total_score 动态计算
- stock_name 不存储，读取时从 stock_info 查询

**读取优化**：
```sql
SELECT date, stock_code, factor_name, val_numeric, val_text
FROM ranking_factor
WHERE (date, stock_code) IN (
  SELECT date, stock_code FROM (
    SELECT date, stock_code,
           ROW_NUMBER() OVER (
             PARTITION BY date
             ORDER BY val_numeric DESC
           ) AS rn
    FROM ranking_factor
    WHERE factor_name = 'total_score'
  ) WHERE rn <= ?
)
```

当前 `loadRanking()` 读取指定日期的因子后在 Node 内存中重建 `RankingRow` 并动态编号；上述窗口查询保留为跨多日批量回测的扩展方案。

### 3.6 排行榜冗余表 (stock_ranking)

**设计目标**：向下兼容旧代码，提供快速查询

**与 ranking_factor 的关系**：
- ranking_factor：主表，灵活 KV 存储
- stock_ranking：冗余表，固定字段，包含 rank 和 stock_name

**写入时机**：
```typescript
const normalized = sqlite.saveRanking(result);
// saveRanking() 在一个 BEGIN IMMEDIATE 事务内同时写入：
// stock_info / sector_info / ranking_factor / stock_ranking / ranking_snapshot
```

**读取优先级**：
```typescript
const factors = sqlite.getRankingFactorsForDate(date);
if (factors.length) return sqlite.loadRanking(date); // 从 KV 因子重建
return sqlite.loadRanking(date);                     // 因子为空时读 stock_ranking
```

## 4. 数据库操作优化

### 4.1 连接管理

```typescript
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('server/data/trending.db', {
  enableForeignKeyConstraints: true,
});
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);
```

**WAL 模式优势**：
- 读写并发：读操作不阻塞写操作
- 批量写入性能提升
- 崩溃恢复更安全

### 4.2 批量写入优化

**问题**：逐条 INSERT 需要多次打开连接，性能差

**解决方案**：
```typescript
db.exec('BEGIN IMMEDIATE');
try {
  const statement = db.prepare(`
    INSERT INTO ranking_factor (date, stock_code, factor_name, val_numeric, val_text)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, stock_code, factor_name) DO UPDATE SET
      val_numeric = excluded.val_numeric,
      val_text = excluded.val_text
  `);
  for (const factor of factors) statement.run(...factor);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

**性能对比**：
- 逐条提交：1000条 × 10ms = 10s
- 批量提交：1000条 × 0.01ms + 100ms = 110ms

### 4.3 全量加载优化

**问题**：回测需要加载全部行情/涨停/排行榜，逐次查询慢

**解决方案**：
```typescript
const rows = db.prepare(`
  SELECT stock_code, date, open, close, change_rate
  FROM stock_daily_price
  ORDER BY stock_code, date
`).all();

const priceClose = new Map(rows.map((row) => [
  `${row.stock_code}:${row.date}`,
  Number(row.close),
]));
```

**内存占用**：
- 10万条行情 ≈ 50MB
- 回测结束后自动释放

### 4.4 索引设计原则

**高频查询字段**：
```sql
-- 按日期查询涨停
CREATE INDEX idx_limit_up_date ON limit_up_record(date);

-- 按板块+日期查询
CREATE INDEX idx_limit_up_sector ON limit_up_record(sector_code, date);

-- 按股票+日期查询行情
CREATE INDEX idx_daily_price_code_date ON stock_daily_price(stock_code, date);
```

**唯一约束**：
```sql
-- 防止重复写入
UNIQUE(date, stock_code)  -- 涨停记录
UNIQUE(stock_code, date)  -- 股票行情
UNIQUE(symbol, date)      -- 指数行情
UNIQUE(date, sector_code) -- 板块趋势
UNIQUE(date, stock_code, factor_name) -- 排行因子
```

## 5. 缓存策略

### 5.1 分析结果缓存

**缓存文件**：`server/data/runtime/analysis.json`

SQLite 中的 `sector_trend_daily` 与 `limit_up_record` 是板块和涨停事实主数据。读取分析结果时，即使 JSON 缓存过期、损坏或与数据库不一致，也以 SQLite 重建的 `blocks` / `sentiment` 为准；JSON 只补充指数分析、统计字段和备注。

缓存中的 `source_date` 保存这些 blocktop 事实所属的 `YYYYMMDD` 交易日；聚合刷新只改变 `timestamp`，不会改变 `source_date`。因此数据库文件需要从 JSON 兼容恢复时，也不会把旧名单错误写到刷新日。

`GET /api/analysis?refresh=1` 只刷新聚合缓存，不写 `limit_up_record`。只有成功取得同花顺 `block_top.stock_list` 的 `POST /api/analysis/collect` 才能写入涨停事实。

**缓存内容**：
```json
{
  "timestamp": "2024-01-15 14:30:00",
  "indices": [...],  // 指数分析结果
  "blocks": [...],   // 板块分析结果
  "sentiment": {...} // 市场情绪
}
```

### 5.2 排行榜缓存

**缓存文件**：`server/data/runtime/ranking.json`

**更新策略**：
- 手动触发：`POST /api/ranking/compute`
- 结构化主数据始终写入 `ranking_factor` / `stock_ranking`
- 数据库为空时可兼容导入旧版 `server/data/ranking.json`

**缓存内容**：
```json
{
  "timestamp": "2024-01-15 15:00:00",
  "date": "20240115",
  "total_stocks": 1500,
  "rankings": [...]
}
```

### 5.3 回测结果归档

**存储结构**：
```
server/data/runtime/backtests/
├── 20240115_143000.json    # 完整结果（含交易与净值曲线）
└── 20240114_150000.json
```

`listBacktests()` 扫描归档文件并在内存中生成摘要，不维护容易失同步的独立索引文件。旧版 `server/data/backtests/*.json` 仍可读取，删除旧归档时使用 `runtime/deleted-backtests.json` 墓碑兼容只读种子。

## 6. 数据一致性保证

### 6.1 事务管理

```typescript
db.exec('BEGIN IMMEDIATE');
try {
  for (const record of records) statement.run(...record);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

### 6.2 数据校验

**写入前校验**：
```typescript
if (!/^\d{6}$/.test(stockCode)) continue;
if (!stockName.trim()) continue;
const continueNum = Math.min(15, Math.max(1, Math.trunc(rawContinueNum)));
```

数据库还使用 `CHECK`、主键和外键作第二层校验；任一 SQL 失败会回滚整个批次。

### 6.3 Upsert 语义

**防止重复写入**：
```sql
INSERT INTO limit_up_record (...)
VALUES (...)
ON CONFLICT(date, stock_code) DO UPDATE SET
    stock_name = excluded.stock_name,
    continue_num = excluded.continue_num,
    ...
```

**场景**：
- 同一天的涨停数据多次采集
- 排行榜因子重复计算
- 行情数据补取覆盖

## 7. 数据迁移与版本管理

### 7.1 表结构演进

**当前版本**：
- v1.0: 基础表（stock_info, sector_info, limit_up_record, stock_daily_price）
- v1.1: 新增 index_daily_price（指数独立存储）
- v1.2: 新增 sector_trend_daily（板块趋势缓存）
- v1.3: 新增 ranking_factor（灵活 KV 存储）
- v1.4: 保留 stock_ranking（向下兼容）

**迁移策略**：
```typescript
private initialize(): void {
  this.database.exec(`
    CREATE TABLE IF NOT EXISTS ranking_factor (...);
    CREATE TABLE IF NOT EXISTS stock_ranking (...);
    CREATE INDEX IF NOT EXISTS idx_ranking_factor_total (...);
    PRAGMA user_version = 14;
  `);
}
```

`14` 表示文档中的 v1.4。初始化可重复执行；新数据库一次创建完整结构，已有同版本数据库不会重复建表或索引。

### 7.2 数据清理

```typescript
this.transaction(() => {
  this.database.exec('DELETE FROM ranking_factor; DELETE FROM stock_ranking; DELETE FROM ranking_snapshot;');
  this.database.exec('DROP TABLE IF EXISTS ranking_intermediate;');
});
// DataStore.clearRankingData() 同时删除 runtime/ranking.json 与旧版 ranking.json，
// 避免清空后又从 JSON 缓存自动回灌。
```

**使用场景**：
- 因子架构重构
- 全量重新计算排行榜

## 8. 备份与恢复

### 8.1 数据库备份

```bash
# SQLite 在线备份（WAL 模式下推荐）
sqlite3 server/data/trending.db ".backup 'server/data/trending.db.backup'"

# 或使用 .dump 命令导出 SQL
sqlite3 server/data/trending.db .dump > backup.sql
```

### 8.2 缓存文件备份

```bash
# 备份缓存目录
tar -czf runtime_cache_backup.tar.gz server/data/runtime/
```

### 8.3 恢复流程

```bash
# 恢复数据库（服务停止后）
cp server/data/trending.db.backup server/data/trending.db

# 恢复缓存
tar -xzf runtime_cache_backup.tar.gz
```

## 9. 性能监控

### 9.1 查询性能

**慢查询识别**：
```typescript
const started = performance.now();
const rows = db.prepare(sql).all(stockCode, limit);
const elapsedMs = performance.now() - started;
if (elapsedMs > 100) console.warn(`[慢查询] getStockPrices: ${elapsedMs.toFixed(1)}ms`);
```

### 9.2 存储空间

```typescript
const { size } = await stat('server/data/trending.db');
const sizeMb = `${(size / 1024 / 1024).toFixed(2)} MB`;
```

**典型占用**：
- 10万条行情：~50MB
- 1万条涨停：~5MB
- 100万条因子：~200MB

## 10. 总结

Trending 数据层设计核心原则：

1. **分层存储**：SQLite 存结构化数据，JSON 存缓存，内存存热点数据
2. **灵活因子**：KV 存储支持快速迭代，无需改表结构
3. **性能优化**：批量写入、全量加载、索引优化
4. **一致性保证**：事务管理、数据校验、Upsert 语义
5. **缓存策略**：SQLite 主数据优先、JSON 可丢弃可重建、回测结果独立归档

数据层为上层业务提供了高效、灵活、可靠的数据支撑。
