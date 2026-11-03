# 数据层

> 数据采集、存储结构、缓存策略与审计日志。

---

## 1. 数据采集层

### 1.1 同花顺板块行情 —— `server/historical-market.ts`

**接口**：`fetchBlockTop(date?) → { blocks: BlockTopData[], source: BlockTopSource }`

采集同花顺 `dataapi/limit_up/block_top` 涨停板块排行。网络失败/被反爬拦截时优雅返回空数组（`source='none'`），由调用方回退到预生成 `analysis.json`。

> **涨停事实唯一来源**：只有 `block_top.stock_list` 中出现并写入 `limit_up_record` 的 `(date, stock_code)` 才视为涨停。项目不会根据日涨幅、证券板块规则或理论涨停价反推涨停；缺少 `block_top` 记录时状态为未知，不做补判。

`GET /api/analysis?refresh=1` 与 `POST /api/analysis/collect` 都会启动真实采集流水线：获取 `block_top`、板块日/周/月 K 线、涨停个股前复权 K 线和指数 K 线。只有关键数据覆盖校验通过后才写入对应交易日的 `limit_up_record` 并把任务标记为完成；网络被拦截或覆盖不足时任务明确失败并保留旧快照。

**解析**：`parseBlockTop(payload) → BlockTopData[]`，兼容 `code`/`block_code`、`stock_list`/`stocks` 等字段别名。

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | str | 板块代码（如 `881145`） |
| `name` | str | 板块名称（如 `半导体`） |
| `change` | float | 板块日涨幅% |
| `limit_up_num` | int | 板块内涨停个股数 |
| `continuous_plate_num` | int | 连板数 |
| `stock_list` | list[dict] | 涨停个股列表 |

**涨停个股列表字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | str | 6 位数字股票代码 |
| `name` | str | 股票名称 |
| `continue_num` | int | 连板数（1-15） |
| `reason_type` | str | 涨停原因分类 |
| `change_rate` | float\|null | 涨幅 |
| `latest` | number\|null | 最新价 |
| `is_st` | bool | 是否 ST |

**数据流向**：`fetchBlockTop()` → `MarketService.refreshLimitUpAnalysis()`（`server/app/market-service.ts`）→ 板块 K 线与涨停个股 K 线采集 → 指数 K 线采集 → 趋势分类 → 批量写入 SQLite 的 `stock_info` / `sector_info` / `limit_up_record` / `sector_trend_daily` / `stock_daily_price` / `index_daily_price`，同时刷新 `analysis.json` 缓存

> `GET /api/analysis?refresh=1` 与 `POST /api/analysis/collect` 当前都走 `MarketService.refreshLimitUpAnalysis()`，路由层只在 `/server/app/routes.ts` 中授权和分发。

**回测采集扩展**：`collectHistoricalMarketData()` 现在还会采集回测日期范围内的历史 `block_top` 涨停记录和板块指数日线（`block_daily_price`），用于回测中的板块趋势滚动计算。调用方可传入 `existingLimitUpRecords`/`existingBlockSeries` 跳过网络请求，从已有 SQLite 数据加载。

### 1.2 板块 K 线行情 —— `server/historical-market.ts`

**接口**：`fetchBlockKlines(code, period, limit) → { klines: KLineData[], source, name? }`

获取板块日/周/月 K 线，数据源为同花顺 `d.10jqka.com.cn`。

| 参数 | 值 | 说明 |
|------|------|------|
| `code` | `881145` | 板块代码（自动标准化 `bk_` 前缀） |
| `period` | `01` / `11` / `21` | 日/周/月（同花顺编码） |
| `limit` | 120 | 返回条数上限 |
| 返回 | `KLineData[]` | `date/open/high/low/close/volume/amount` |

**解析**：`parseBlockKlines(payload, limit)` → 解析同花顺 v4 JSONP 格式，自动补齐 `changeRate`。

**数据流向**：`fetchBlockKlines(code, "01")` → `analyzeBlockTrend()`（scoring-engine）→ 板块趋势状态

### 1.3 同花顺板块涨停明细

`fetchBlockTop()` 返回的 `stock_list` 即为涨停明细，结构：

```
板块1: 半导体
  ├─ 股票A (3连板) - 国产替代
  ├─ 股票B (2连板) - 半导体设备
  └─ 股票C (首板)  - 封测

板块2: 新能源
  ├─ 股票D (2连板) - 锂电池
  └─ 股票E (首板)  - 光伏
```

### 1.4 个股行情 —— `server/historical-market.ts`

**接口**：`fetchAdjustedKlines(symbol, limit) → { klines: KLineData[], source }`

多数据源前复权 K 线获取（腾讯 → 新浪 → 东方财富）。

**市场前缀规则**：
- `sh` + 代码：60/68/5/9 开头（上海主板/科创板）
- `sz` + 代码：00/30 开头（深圳主板/创业板）

**数据源降级链路**：

| 优先级 | 数据源 | 端点 | 覆盖 |
|--------|--------|------|------|
| 1 | 腾讯财经 | `web.ifzq.gtimg.cn` qfqday | 复权 K 线 |
| 2 | 新浪财经 | `money.finance.sina.com.cn` + 复权因子 | 自行前复权 |
| 3 | 东方财富 | `push2his.eastmoney.com` 前复权 | 复权日线 |

**解析函数**：
- `parseTencentKlines(rows) → KLineData[]` — 腾讯 qfqday 格式，成交量（手→股）
- `parseSinaKlines(rows, factors, limit) → KLineData[]` — 新浪 + 复权因子自行前复权
- `parseEastmoneyAdjustedKlines(lines) → KLineData[]` — 东方财富前复权 CSV

**数据流向**：`fetchAdjustedKlines()` → `collectHistoricalMarketData()` → 单事务批量 upsert 到 SQLite 的 `stock_daily_price`，快照范围写入 `historical_snapshot`

### 1.5 中证指数行情 —— `server/historical-market.ts`

**接口**：`fetchAdjustedKlines(symbol, limit)`（复用个股行情接口）

指数数据也可通过 `fetchAdjustedKlines()` 实时采集，与前复权个股共用同一多源降级链路。`analysis.json` 中的指数状态数据来自外部预生成，但 `scoring-engine.ts` 中的 `classifyMarketState()` 可在本地对任意 K 线做七态分类。

**覆盖指数**：

| 指数 | 代码 | 覆盖范围 |
|------|------|------|
| 上证指数 | `sh000001` | 全市场 |
| 深证成指 | `sz399001` | 深市 |
| 创业板指 | `sz399006` | 创业板 |
| 科创50 | `sh000688` | 科创板 |
| 沪深300 | `sh000300` | 大盘蓝筹 |
| 中证500 | `sh000905` | 中盘成长 |
| 中证白酒 | `sz399997` | 消费细分 |
| 中证医药 | `sh000933` | 医药 |
| 证券公司 | `sz399975` | 金融 |
| 国证芯片 | `sz980017` | 科技 |
| 中证军工 | `sz399967` | 军工 |

**数据流向**：`fetchAdjustedKlines()` → SQLite `index_daily_price`（网络失败时可从库内回退）→ `analysis.json` 指数状态缓存，或 `classifyMarketState()` 本地分类

---
## 2. 回测时段板块行情采集

### 2.1 历史涨停记录采集

`collectHistoricalMarketData()` 会遍历回测日期范围内的每个交易日，调用 `fetchBlockTop(date)` 获取当天的 `block_top` 涨停数据。记录写入 `HistoricalMarketData.limit_up_records` 数组，并最终持久化到 SQLite `limit_up_record` 表。

**跳过机制**：如果调用方传入 `existingLimitUpRecords`（来自 SQLite 已有数据），则跳过网络请求，直接过滤出属于回测日期范围的记录。

### 2.2 板块指数日线采集

从回测日期范围内出现的涨停板块代码中，采集对应的板块指数日 K 线（同花顺 `fetchBlockKlines(code, "01", 250)`）。写入 `HistoricalMarketData.blocks` 数组，并持久化到 SQLite `block_daily_price` 表。

**跳过机制**：如果调用方传入 `existingBlockSeries`，则跳过网络请求。

### 2.3 数据流向

```
回测时段涨停记录 + 板块 K 线
  │
  ├─ HistoricalMarketData.limit_up_records
  │     └─ 用于回测中涨停事实核验（limitUpDatesByCode / limitUpCodesByDate）
  │
  └─ HistoricalMarketData.blocks
        └─ computeSectorStates() → 滚动计算板块趋势状态
             └─ 向量化评分中的板块趋势加/减分（sector_bonus）
```

---

## 3. 因子存储架构

**当前实现**：SQLite `ranking_factor` 是因子主表，使用 `(date, stock_code, factor_name)` 复合主键；`stock_ranking` 保存固定字段作为向下兼容冗余表；`server/data/runtime/ranking.json` 仅保留最新排行榜缓存。

| 字段 | 说明 | 类型 | 分值 |
|------|------|------|------|
| `total_score` | 总分 | numeric | 0-100 |
| `trend_score` | 趋势评分 | numeric | 0-40 |
| `volume_price_score` | 价量评分 | numeric | 0-25 |
| `position_score` | 距60日低点评分 | numeric | 0-20 |
| `volatility_trend_score` | 波动率适配评分 | numeric | 0-15 |
| `relative_strength_score` | 相对大盘强度评分 | numeric | 0-20 |
| `sector_strategy_score` | 板块趋势 × 个股形态修正 | numeric | 默认规则 -10~+8，配置硬上限 -12~+10 |
| `sector_risk_penalty` | 情境风险扣分 | numeric | ≤0；触发时机会分为 0 |
| `sector_opportunity_bonus` | 情境机会加分 | numeric | ≥0 |
| `sector_strategy_label` | 情境修正标签 | text | 如“穿越板块稳定上行”“强势行情放量新高” |
| `sector_strategy_reason` | 情境修正解释 | text | 板块状态与关键形态指标 |
| `alignment` | 均线排列 | text | bullish/tangled/bearish |
| `trend_strength` | 趋势强度 | numeric | 线性回归斜率/均价 |
| `volume_price_label` | 价量配合标签 | text | 如"稳健放量" |
| `volatility_class` | 波动率分类 | text | high/medium/low |
| `limit_up_count_20d` | 20日涨停次数 | numeric | ≥0 |
| `sector_code` | 板块代码 | text | 如"881145" |
| `sector_name` | 板块名称 | text | 如"半导体" |
| `sector_trend_name` | 板块趋势 | text | 如"主线主升" |
| `strategy_action` | 策略动作 | text | accumulate/trade/reduce/ignore |
| `strategy_label` | 策略标签 | text | 如"重点加仓" |
| `strategy_position` | 仓位建议 | text | 如"7-9成" |
| `latest_price` | 最新价 | numeric | — |
| `latest_change_rate` | 最新涨跌幅% | numeric | — |

写入时在一个事务内完成股票/板块基础信息、KV 因子和冗余排行表的批量写入。读取优先从 `ranking_factor` 重建结果，按 `total_score` 动态排名；若因子表为空才降级读取 `stock_ranking`。旧版 `ranking.json` 会在数据库为空时自动导入一次。

### 3.1 排行运行时配置 —— `server/ranking-config.ts`

排行计算支持从回测优化结果回填因子权重和评分配置，持久化为 `data/runtime/ranking-config.json`。

**结构**（`RankingRuntimeConfig`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `factor_weights` | `FactorWeights` | 五维因子权重（`trendWeightPct` / `volumePriceWeightPct` / `distanceFromLowWeightPct` / `volatilityTrendWeightPct` / `relativeStrengthWeightPct`），范围 1–200，归一化后总分恒为 100 分制 |
| `scoring_config` | `ScoreStockConfig` | 评分参数配置（距低点分档阈值、趋势参数、波动率矩阵） |
| `applied_backtest_run_id` | string? | 来源回测 run_id，便于溯源 |
| `updated_at` | string | 更新时间戳 |

**来源优先级**：`POST /api/ranking/compute` 显式传入 > `ranking-config.json` 已保存配置 > `defaultRankingRuntimeConfig()`（默认权重 + 默认评分配置）。

**写入时机**：`POST /api/simulated-trading/strategy/apply-backtest` 同时保存排行配置和策略参数，并触发排行重算。

### 3.2 优化结果持久化

`data/runtime/optimize-result.json` 保存最近一次参数优化完整结果（`ParamOptimizeResult`），可通过 `GET /api/backtest/optimize-result` 读取。内容包含阶段 1 评分配置、阶段 2 交易参数、验证指标、基线对比等（详见 `logic.md` §3.4 输出结构）。

### 3.3 挖掘产物落库（P4/P5）—— `server/pipeline/store.ts`

策略挖掘产物以**文件**形式落在独立目录 `server/data/mining/`（gitignore，不进 SQLite、不进交易链路），凭 `runId` 可复现：

| 路径 | 内容 |
|------|------|
| `runs/<runId>.json` | `MiningRun`：创建时间、`codeVersion`（git commit hash）、`dataVersion`（最后交易日 + 校验摘要）、标的池、启用子策略、完整配置、status（success/failed + error）、数据质量报告 |
| `results/<runId>.json` | `MiningResult[]`：参数组合、样本内/样本外指标（P1 统一口径）、稳定性得分、样本外交易笔数与区间、排名、unstable 标记 |
| `reports/<runId>.html` / `.json` | `MiningReport`：质量报告、warnings、验证段拼接的整体指标、候选列表、摩擦校准（如有） |
| `calibration/<runId>.json` | P5 摩擦校准：实测不利滑点率、未成交率、撤单率，下一轮挖掘读取最新一条覆盖回测默认滑点 |
| `instances/<instanceId>.json` | P5 下发实例配置：来源 `runId + rank`、操作人、参数、标的池、资金上限、`channel: 'simulated'` |
| `instances/<instanceId>/state.json` | 实例独立运行状态（含指令），与生产 `paper_trading` 状态完全分离 |

**数据质量门槛**（`quality.ts`，开跑前校验，未通过则运行失败而非带病继续）：行情连续性覆盖率 ≥ 80%、涨停记录覆盖率 ≥ 60%、行情必须为前复权；缺口明细（缺失交易日、除权问题、涨停缺失日）写入 `DataQualityReport.gaps`，不静默跳过。

---

## 4. SQLite 运维

```bash
# 查看表与索引
sqlite3 server/data/trending.db '.tables'
sqlite3 server/data/trending.db 'PRAGMA journal_mode; PRAGMA foreign_keys; PRAGMA user_version;'

# 在线安全备份（推荐）
sqlite3 server/data/trending.db ".backup 'server/data/trending.db.backup'"
```

`GET /api/health` 的 `storage` 字段同时返回数据库路径、WAL 状态、外键状态、`busy_timeout`、同步级别、schema version 和表清单。

### 4.1 新增表 —— `block_daily_price`

板块指数日 K 线持久化（v15 引入），支持回测中滚动计算板块趋势而无需重复网络请求。

| 字段 | 类型 | 说明 |
|------|------|------|
| `block_code` | TEXT | 板块代码（6 位数字） |
| `block_name` | TEXT | 板块名称 |
| `date` | TEXT | 日期 YYYY-MM-DD |
| `open/close/high/low` | REAL | 开高低收 |
| `volume` | REAL | 成交量 |
| `amount` | REAL | 成交额 |
| `change_rate` | REAL | 涨跌幅 |
| `created_at` | TEXT | 创建时间戳 |

**主键**：`(block_code, date)` WITHOUT ROWID

### 4.2 新增表 —— `paper_instruction`

模拟交易指令持久化（v15 引入），替代原先仅存于 JSON 状态文件的指令列表，确保重启后指令不丢失。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT | 指令唯一 ID |
| `side` | TEXT | `buy` / `sell` |
| `stock_code` | TEXT | 股票代码 |
| `signal_date` | TEXT | 信号日期 |
| `signal_price` | REAL | 信号日参考价格 |
| `quantity` | INTEGER | 委托数量 |
| `rank` | INTEGER | 排行榜排名（可选） |
| `strategy_label` | TEXT | 策略标签 |
| `reason` | TEXT | 交易原因 |
| `execution_window` | TEXT | 执行窗口 `open` / `near_close` |
| `status` | TEXT | `pending` / `submitting` / `submitted` / `filled` / `skipped` / `failed` |
| `created_at` | TEXT | 创建时间 |
| `submitted_at` | TEXT | 提交时间 |
| `completed_at` | TEXT | 完成时间 |
| `broker_status` | TEXT | 券商状态 |
| `execution_price` | REAL | 成交价格 |

### 4.3 `limit_up_record` 表变更

v15 迁移移除了 `limit_up_record` 表中的冗余列 `stock_name` 和 `sector_name`，改由读取时 JOIN `stock_info` / `sector_info` 表获取。这消除了数据冗余，确保名称一致性。

### 4.4 `sector_trend_daily` 表变更

v16 迁移将 `state_id` 的 CHECK 约束从 `BETWEEN 1 AND 7` 扩展为 `BETWEEN 0 AND 7`，允许 `0` 表示"数据不足"状态。v18 起又允许 `state_id=8`（"筑底成功"），与 `STATE_NAMES`（`server/sqlite/helpers.ts`）和 `scoring-engine.ts` 的 `STATE_TABLE` 对齐。同时修复了 `state_name` 与 `state_id` 不匹配的历史脏数据。

### 4.5 数据迁移流程

数据库版本从 v14 升级到 v18，迁移流程：

```typescript
// v15: 移除 limit_up_record 冗余列
ALTER TABLE limit_up_record DROP COLUMN stock_name;
ALTER TABLE limit_up_record DROP COLUMN sector_name;

// v16: 扩展 sector_trend_daily state_id 约束
CREATE TABLE sector_trend_daily_new (...) CHECK (state_id BETWEEN 0 AND 7);
INSERT INTO sector_trend_daily_new SELECT * FROM sector_trend_daily;
DROP TABLE sector_trend_daily;
ALTER TABLE sector_trend_daily_new RENAME TO sector_trend_daily;
UPDATE sector_trend_daily SET state_id = 0 WHERE state_name = '数据不足';

// v18: 最终版本号 — 不再扩充表，仅提示约束上限为 8。
PRAGMA user_version = 18;
```

迁移入口集中在 `server/sqlite/schema.ts` 的 `initializeSchema()`（PRAGMA + 建表 + `migrateV15/migrateV16`），逻辑层在 `server/sqlite/helpers.ts` 维护 `STATE_NAMES` / `LimitUpRecord` 等共享类型与工具函数，避免再回到 `sqlite-store.ts` 中混杂维护。

---

## 5. 审计日志 —— `server/audit-log.ts`

每个重要操作都有审计记录，存储为 `data/runtime/logs/quant-audit-YYYYMMDD.jsonl`。

**日志级别**：`debug` | `info` | `warn` | `error`

**关键审计事件**：

| 组件 | 事件 | 级别 |
|------|------|------|
| `http` | request_started / completed / failed | info / error |
| `market_data` | collection_started / completed / failed / snapshot_saved / stock_loaded / stock_fetch_failed / limit_up_skip_fetch / limit_up_collection_done / block_kline_skip_fetch / block_kline_collection_done | info / error |
| `market_analysis` | analysis_refreshed / limit_up_collected / limit_up_collection_empty | info / warn |
| `factor_ranking` | ranking_started / completed / historical_ranking_completed | info |
| `backtest` | run_started / completed | info |
| `paper_trading` | window_started / completed / failed | info / error |
| `strategy` | close_evaluation / entry_candidate | debug |
| `order` | submission_started / verified / uncertain | info / error |
| `account_monitor` | account_changed / monitor_failed | info / error |
| `ths_broker` | snapshot_parsed / order_verified | info |
| `ths_applescript` | command_started / completed / failed | info / error |
