# 数据层设计文档

> **Node 实现约束**：项目使用 Node.js 22.13+ 内置的 `node:sqlite`（`DatabaseSync`），数据库位于 `server/data/trending.db`。`server/data/` 整体加入 `.gitignore`，仓库和 Git 历史不保存行情、排行、账户状态或回测数据。

**数据库版本**：v17

## 1. 数据存储架构

Trending 采用**多层级存储**策略，根据数据特性选择最优存储方案：

```
┌──────────────────────────────────────────────────────────┐
│                    SQLite 数据库                          │
│  - 结构化数据：股票/板块/涨停记录/行情/排行榜因子/指令    │
│  - WAL 模式，支持并发读写                                │
│  - 外键约束，保证数据一致性                              │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                    JSON 缓存文件                          │
│  - runtime/analysis.json: 指数与聚合字段缓存              │
│  - runtime/ranking.json: 最新排行榜缓存                   │
│  - runtime/backtests/: 回测结果 JSON 归档                 │
│  - runtime/paper-trading-state.json: 自动化状态           │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                    内存缓存                               │
│  - TaskRegistry: 任务状态快照                             │
│  - 回测预加载: SQLite 行情/涨停字典/评分矩阵              │
└──────────────────────────────────────────────────────────┘
```

## 2. 数据库表结构设计

### 2.1 表结构总览

```sql
-- 股票信息表
stock_info (code, name, market, created_at, updated_at)

-- 板块信息表
sector_info (code, name, created_at, updated_at)

-- 涨停记录表（无冗余名称列，通过 JOIN 获取）
limit_up_record (date, stock_code, sector_code,
                 continue_num, reason_type, sector_change, latest, change_rate, created_at)

-- 股票行情表
stock_daily_price (stock_code, stock_name, date, open, close, high, low,
                   volume, amount, change_rate, created_at)

-- 指数行情表（独立于个股）
index_daily_price (symbol, index_name, date, open, close, high, low,
                   volume, amount, change_rate, created_at)

-- 板块指数日线表（用于回测滚动计算板块趋势）
block_daily_price (block_code, block_name, date, open, close, high, low,
                   volume, amount, change_rate, created_at)

-- 板块每日趋势判读表（state_id 范围 0-7，0=数据不足）
sector_trend_daily (date, sector_code, sector_name, state_id, state_name,
                    trend, latest, ma5, ma20, near_high, volume_trend,
                    strategy_action, strategy_label, strategy_position, computed_at)

-- 排行榜因子表（灵活 KV 存储）
ranking_factor (date, stock_code, factor_name, val_numeric, val_text)

-- 排行榜表（向下兼容）
stock_ranking (date, stock_code, stock_name, rank, total_score, ...)

-- 模拟交易指令表（持久化，重启不丢失）
paper_instruction (id, side, stock_code, signal_date, signal_price, quantity,
                   rank, strategy_label, reason, execution_window,
                   status, created_at, submitted_at, completed_at, broker_status, execution_price)

-- 最新排行榜与历史行情快照元数据
ranking_snapshot (date, timestamp, total_stocks, updated_at)
historical_snapshot (singleton, schema_version, source, generated_at, as_of_date, ...)
```

### 2.2 表关系图

```
┌─────────────────┐
│   stock_info    │
│  (股票基础信息)  │
└────────┬────────┘
         │ code
         ├──────────────────────────────────────┐
         │                                      │
         ↓                                      ↓
┌─────────────────┐                   ┌─────────────────┐
│stock_daily_price│                   │ limit_up_record │
│  (个股日行情)    │                   │  (涨停记录)      │
└─────────────────┘                   └────────┬────────┘
                                               │ sector_code
                                               ↓
                                      ┌─────────────────┐
                                      │   sector_info   │
                                      │ (板块基础信息)   │
                                      └────────┬────────┘
                                               │ code
         ┌──────────────┬──────────────────────┼──────────────────┐
         │              │                      │                  │
         ↓              ↓                      ↓                  ↓
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│sector_trend     │  │ block_daily_    │  │ ranking_factor  │  │ stock_ranking   │
│_daily           │  │ price           │  │ (排行榜因子KV)  │  │ (排行榜冗余表)  │
│ (板块趋势判读)  │  │ (板块指数日线)  │  └─────────────────┘  └─────────────────┘
└─────────────────┘  └─────────────────┘
```

## 3. 核心表设计详解

### 3.1 涨停记录表 (limit_up_record)

**设计目标**：记录每日涨停个股信息，支持历史回测

**权威来源约束**：记录只能来自同花顺 `dataapi/limit_up/block_top` 的 `stock_list`。禁止根据日涨幅、股票代码板块、ST 标识或理论涨停价生成涨停记录；缺少 block_top 数据时保持未知，不做价格补判。

**v15 变更**：移除了 `stock_name` 和 `sector_name` 冗余列，改由读取时 JOIN `stock_info` / `sector_info` 表获取。

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| date | TEXT | 日期 YYYYMMDD |
| stock_code | TEXT | 股票代码（6位）→ FK stock_info(code) |
| sector_code | TEXT | 板块代码 → FK sector_info(code) |
| continue_num | INTEGER | 连板数（1-15） |
| reason_type | TEXT | 涨停原因 |
| sector_change | REAL | 板块涨幅 |
| latest | REAL | block_top 返回的最新价，可空 |
| change_rate | REAL | block_top 返回的涨幅，可空；不用于反推涨停 |

**索引设计**：
```sql
CREATE INDEX idx_limit_up_date ON limit_up_record(date);
CREATE INDEX idx_limit_up_sector ON limit_up_record(sector_code, date);
PRIMARY KEY (date, stock_code);  -- WITHOUT ROWID
```

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
PRIMARY KEY (stock_code, date);  -- WITHOUT ROWID
```

### 3.3 指数行情表 (index_daily_price)

**设计目标**：独立存储指数日 K 线，避免与个股代码冲突

**设计背景**：
- 上证指数代码 `sh000001`，与平安银行 `000001` 冲突
- 指数使用带市场前缀的 symbol（如 sh000001）作为主键
- 与个股行情解耦，独立管理

### 3.4 板块指数日线表 (block_daily_price)

**设计目标**：持久化板块指数日 K 线，支持回测中滚动计算板块趋势

**v15 引入**。

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| block_code | TEXT | 板块代码（6 位数字）→ FK sector_info(code) |
| block_name | TEXT | 板块名称 |
| date | TEXT | 日期 YYYY-MM-DD |
| open/close/high/low | REAL | 开高低收 |
| volume | REAL | 成交量 |
| amount | REAL | 成交额 |
| change_rate | REAL | 涨跌幅 |
| created_at | TEXT | 创建时间 |

**索引**：
```sql
CREATE INDEX idx_block_price_code_date ON block_daily_price(block_code, date);
PRIMARY KEY (block_code, date);  -- WITHOUT ROWID
```

### 3.5 板块趋势判读表 (sector_trend_daily)

**设计目标**：缓存板块趋势计算结果，避免回测重复计算

**v16 变更**：`state_id` 的 CHECK 约束从 `BETWEEN 1 AND 7` 扩展为 `BETWEEN 0 AND 7`，允许 `0` 表示"数据不足"状态。

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| date | TEXT | 日期 |
| sector_code | TEXT | 板块代码 |
| state_id | INTEGER | 状态ID（0-7，0=数据不足） |
| state_name | TEXT | 状态名称 |
| trend | TEXT | 趋势方向 |
| latest/ma5/ma20 | REAL | 价格与均线 |
| near_high | TEXT | 距高点距离 |
| volume_trend | TEXT | 成交量趋势 |
| strategy_action/label/position | TEXT | 策略建议 |

### 3.6 排行榜因子表 (ranking_factor)

**设计目标**：灵活 KV 存储，支持快速迭代新因子

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
| limit_up_count_20d | numeric | 最近20日 block_top 权威涨停次数 |
| alignment | text | 均线排列（bullish/bearish/tangled） |
| volume_price_label | text | 价量配合标签 |
| sector_trend_name | text | 板块趋势状态名 |

### 3.7 模拟交易指令表 (paper_instruction)

**设计目标**：持久化模拟交易指令，重启后不丢失

**v15 引入**。替代原先仅存于 JSON 状态文件的指令列表。`DataStore` 读取时自动从 JSON 迁移旧数据到 SQLite，后续以 SQLite 为权威来源。

**字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 指令唯一 ID |
| side | TEXT | `buy` / `sell` |
| stock_code | TEXT | 股票代码 → FK stock_info(code) |
| signal_date | TEXT | 信号日期 |
| signal_price | REAL | 信号日参考价格 |
| quantity | INTEGER | 委托数量 |
| rank | INTEGER | 排行榜排名（可选） |
| strategy_label | TEXT | 策略标签 |
| reason | TEXT | 交易原因 |
| execution_window | TEXT | 执行窗口 `open` / `near_close` |
| status | TEXT | pending/submitting/submitted/filled/skipped/failed |
| created_at | TEXT | 创建时间 |
| submitted_at | TEXT | 提交时间 |
| completed_at | TEXT | 完成时间 |
| broker_status | TEXT | 券商状态 |
| execution_price | REAL | 成交价格 |

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

### 4.2 批量写入优化

```typescript
db.exec('BEGIN IMMEDIATE');
try {
  const statement = db.prepare(`INSERT INTO ranking_factor (...) VALUES (...) ON CONFLICT...`);
  for (const factor of factors) statement.run(...factor);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

### 4.3 数据迁移流程

数据库版本从 v14 升级到 v17：

```typescript
// v15: 移除 limit_up_record 冗余列
ALTER TABLE limit_up_record DROP COLUMN stock_name;
ALTER TABLE limit_up_record DROP COLUMN sector_name;

// v16: 扩展 sector_trend_daily state_id 约束
CREATE TABLE sector_trend_daily_new (... CHECK (state_id BETWEEN 0 AND 7));
INSERT INTO sector_trend_daily_new SELECT * FROM sector_trend_daily;
DROP TABLE sector_trend_daily;
ALTER TABLE sector_trend_daily_new RENAME TO sector_trend_daily;
UPDATE sector_trend_daily SET state_id = 0 WHERE state_name = '数据不足';

// v17: 最终版本号
PRAGMA user_version = 17;
```

## 5. 缓存策略

### 5.1 分析结果缓存

**缓存文件**：`server/data/runtime/analysis.json`

SQLite 中的 `sector_trend_daily` 与 `limit_up_record` 是板块和涨停事实主数据。读取分析结果时，即使 JSON 缓存过期、损坏或与数据库不一致，也以 SQLite 重建的 `blocks` / `sentiment` 为准。

### 5.2 排行榜缓存

**缓存文件**：`server/data/runtime/ranking.json`

结构化主数据始终写入 `ranking_factor` / `stock_ranking`，JSON 仅作最新缓存。

### 5.3 回测结果归档

```
server/data/runtime/backtests/
├── 20260723_012253.json    # 完整结果（含交易与净值曲线）
└── ...
```

### 5.4 自动化状态

```
server/data/runtime/paper-trading-state.json  # 自动化开关、已完成窗口、资金
SQLite paper_instruction 表                    # 指令持久化（权威来源）
```

## 6. 数据一致性保证

- **事务管理**：`BEGIN IMMEDIATE` + `COMMIT` / `ROLLBACK`
- **写入前校验**：代码 6 位数字、连板数 1-15、CHECK 约束
- **Upsert 语义**：`ON CONFLICT ... DO UPDATE SET` 防止重复写入
- **外键约束**：`limit_up_record.sector_code → sector_info(code)` 等