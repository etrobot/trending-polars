# 全流程文档：从数据采集到交易执行（Node.js / TypeScript 版）

> **说明**：本文档基于 `trending-polars` 项目当前代码编写，反映 TypeScript 实现的实际状态。标记为「🚧 未实现」的功能是设计目标，待后续开发。

---

## 1. 流程总览

```
同花顺板块行情                    腾讯财经指数行情
      │                                  │
      ▼                                  ▼
  涨停数据采集 ──► 情绪分析 ──► 指数趋势分析        ← 本地 scoring-engine 聚合
      │                                  │
      ▼                                  ▼
  板块 K 线分析 ──► 板块趋势分类 ──► 市场状态分类    ← 本地归类（scoring-engine）
      │                                  │
      ▼                                  ▼
  个股行情采集 ◄──────── 排行榜选股 ◄───────────────┘
      │
      ▼
  多因子评分（趋势40+价量25+位置20+波动15）
      │
      ▼
  策略建议生成 ──► 回测验证 ──► 交易计划生成
                                    │
                                    ▼
                            同花顺模拟交易执行
                                    │
                                    ▼
                            持仓监控 & 盈亏计算
                                    │
                                    ▼
                            止盈止损 & 计划刷新
```

**核心逻辑**：指数定仓位 → 情绪定买卖 → 个股定标的 → 回测定参数 → 计划定执行

**技术栈**：TypeScript + Node.js 22.13+ · Express 5 · React 19 · Tailwind CSS 4 · nodejs-polars · `node:sqlite` · WebSocket (ws) · AppleScript 桥接

---

## 2. 数据采集层

### 2.1 同花顺板块行情 —— `server/historical-market.ts`

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

**数据流向**：`fetchBlockTop()` → `collectLimitUpAnalysis()`（app.ts）→ 板块 K 线与涨停个股 K 线采集 → 指数 K 线采集 → 趋势分类 → 批量写入 SQLite 的 `stock_info` / `sector_info` / `limit_up_record` / `sector_trend_daily` / `stock_daily_price` / `index_daily_price`，同时刷新 `analysis.json` 缓存

### 2.2 板块 K 线行情 —— `server/historical-market.ts`

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

### 2.3 同花顺板块涨停明细

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

### 2.4 个股行情 —— `server/historical-market.ts`

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

### 2.5 中证指数行情 —— `server/historical-market.ts`

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

## 3. 行情趋势分析与策略分类

### 3.1 指数趋势分析 —— `server/scoring-engine.ts` + `server/polars-engine.ts`

**入口**：`refreshAnalysis(data) → AnalysisData`（`polars-engine.ts`）做聚合统计；
`classifyMarketState(bars) → MarketStateResult`（`scoring-engine.ts`）做七态分类。

**完整流程**（`scoring-engine.ts` 的 `classifyMarketState()` 实现）：

```
df_daily (K线)
  │
  ├─ calc_all_indicators()
  │     ├─ movingAverage()         → MA5/MA10/MA20/MA60
  │     ├─ trendStrength()         → 趋势强度（线性回归斜率 / 均价）
  │     └─ standardDeviation()     → 波动率
  │
  ├─ classify_market_state()
  │     ├─ alignmentOf()           → bullish / bearish / tangled
  │     ├─ trendStrength()         → 趋势强度数值
  │     ├─ distanceFromHigh        → 距60日高点距离
  │     ├─ return5                 → 近5日涨跌幅
  │     ├─ volumeTrendRatio()      → 量比
  │     └─ volatility              → 波动率
  │
  └─ 输出七种状态之一
```

**七种市场状态**：

| ID | 名称 | 趋势 | 仓位建议 | 信号 |
|----|------|------|---------|------|
| 1 | 主线主升 | 上升 | 7-9成 | buy |
| 2 | 高位滞涨 | 上升 | 3-5成 | sell |
| 3 | 首次回调 | 上升 | 3-5成 | sell |
| 4 | 箱体震荡 | 横盘 | 0-3成 | hold |
| 5 | 缩量无序 | 横盘 | 0成 | empty |
| 6 | 阴跌不止 | 下跌 | 0成 | empty |
| 7 | 恐慌暴跌 | 下跌 | 0-1成 | empty |

**分类规则**（`classifyMarketState()`）：
- 上升趋势（`bullish` 排列或 `trendStrength > 0.003`）：距高点 3% 内且量比≥0.9 → 主线主升；距高点 3% 内且缩量 → 高位滞涨；距高点≥5% → 首次回调
- 下跌趋势（`bearish` 排列或 `trendStrength < -0.003`）：5日跌幅≥8% 或波动率≥4.5 → 恐慌暴跌；否则 → 阴跌不止
- 横盘：量比<0.8 → 缩量无序；否则 → 箱体震荡

### 3.2 板块趋势分析 —— `server/scoring-engine.ts`

**接口**：`analyzeBlockTrend(daily, weekly?, monthly?) → MarketStateResult`

**实现**：`scoring-engine.ts` 的 `analyzeBlockTrend()` 已实现完整的日线七态分类 + 周/月线交叉验证。

```
板块日线K线
  │
  ├─ classifyMarketState() → 日线精细分类（7种状态）
  │
  ├─ 周线粗判断: singlePeriodTrend() → up / down / range
  ├─ 月线粗判断: singlePeriodTrend() → up / down / range
  │
  └─ 交叉验证
       ├─ 日线上升 + 周月均下跌 → 降级为「阴跌不止」（downgraded=true）
       └─ 其他情况 → 正常使用日线状态
```

**输出字段**：`state_id`, `state_name`, `trend`, `position`, `signal`, `latest`, `ma5`, `ma20`, `near_high`, `volume_trend`, `downgraded?`

### 3.3 板块策略矩阵 —— `server/scoring-engine.ts`

**接口**：`blockStrategy(stateId, limitUpNum, maxContinue) → BlockStrategy`

**策略规则**（状态 × 涨停热度）：

| 状态 | 涨停≥5+连板≥2 | 其他 |
|------|--------------|------|
| 1-主线主升 | 主线主升 7-9成 | 趋势跟踪 3-5成 |
| 2-高位滞涨 | 逢高减仓 3-5成 | 逢高减仓 3-5成 |
| 3-首次回调 | 博反抽 3-5成 | 博反抽 3-5成 |
| 4-箱体震荡 | 情绪博弈 3-5成 | 箱体操作 0-3成 |
| 5-缩量无序 | 休息 0成 | 休息 0成 |
| 6-阴跌不止 | 回避 0成 | 回避 0成 |
| 7-恐慌暴跌 | 超跌反弹 0-1成 | 回避 0成 |

### 3.4 市场情绪分类 —— `server/polars-engine.ts`

**实现**：`refreshAnalysis()` 中的实时计算

**阈值规则**：

| 情绪 | 条件 | 行为 |
|------|------|------|
| `hot` | 涨停总数 ≥ 80 | 积极做多，可参与热点板块 |
| `normal` | 涨停总数 30-79 | 正常交易，精选个股 |
| `cold` | 涨停总数 < 30 | 谨慎观望，降低仓位 |

---

## 4. 个股因子评分 —— `server/scoring-engine.ts`（核心引擎）+ `server/backtest-engine.ts`（回测驱动）

### 4.1 两阶段计算架构

```
Phase 1: 数据准备
  ├─ fetchAdjustedKlines() → 多源前复权 K 线
  ├─ prepareSeries() → 排序 + 日期索引
  └─ 可选：SectorContext（板块趋势上下文）

Phase 2: 四维评分计算（scoreStock()）
  ├─ K线趋势评分（40分）
  ├─ 价量配合评分（25分）
  ├─ 价格位置评分（20分）
  └─ 波动率-趋势适配评分（15分）
  → 返回 RankingRow（含策略建议）
```

**核心引擎**：`scoreStock(series, date, sector?) → RankingRow | null`（`scoring-engine.ts`），同时被回测引擎和收盘决策使用。需要至少 20 根 K 线。

### 4.2 评分维度详解

#### 维度 1：K 线趋势评分（40 分）

| 子项 | 分值 | 条件 |
|------|------|------|
| 均线排列基础分 | 28 | bullish=28, tangled=14, bearish=0 |
| 趋势强度加/减分 | ±12 | `min(12, strength × 400)`；强度>0.003 加分，<-0.003 减分 |
| 板块趋势加/减分 | ±4 | 板块上升趋势 +4，下跌趋势 -4 |

**均线排列判断**（`alignmentOf()`）：
- `bullish`：MA5 > MA10 > MA20 > MA60
- `bearish`：MA5 < MA10 < MA20 < MA60
- `tangled`：其他

#### 维度 2：价量配合评分（25 分）

`volumePriceScore(bars, endIndex) → { score, label }`

| 状态 | 分值 | 判断条件 |
|------|------|---------|
| 顶部放量 | 2 | 涨幅>5% + 量比>1.5 + 距60日高点<5% |
| 高位滞涨 | 1 | 涨幅±1%内 + 量比>1.5 + 距高点<5% |
| 放量下跌 | 2 | 量比>1.5 + 下跌 |
| 启动放量 | 20 | 量比>1.5 + 涨幅>3% + 距60日低点>15% |
| 低位启动 | 18 | 量比>1.5 + 涨幅0-3% + 距低点>15% |
| 放量滞涨 | 10 | 量比>1.5 + 涨幅±1% |
| 追高放量 | 12 | 量比>1.5 + 涨幅>5%（非顶部） |
| 稳健放量 | 22 | 量比1.1-1.5 + 涨幅0-3% + 非顶部 |
| 高位稳量 | 14 | 量比1.1-1.5 + 涨幅0-3% + 近高点 |
| 温和放量 | 15 | 量比1.1-1.5 + 涨幅>3% |
| 健康回调 | 8 | 量比1.1-1.5 + 下跌 |
| 缩量上涨 | 12 | 量比<0.8 + 上涨 |
| 缩量下跌 | 10 | 量比<0.8 + 下跌 |
| 量价均衡 | 10 | 其他情况 |

**量比计算**：近5日均量 / 再前5日均量

#### 维度 3：价格位置评分（20 分）

| 状态 | 分值 | 条件 |
|------|------|------|
| 强势多头 | 14 | 收盘 > MA5 > MA20 |
| 偏多 | 10 | 收盘 > MA20 |
| 弱势反弹 | 6 | 收盘 > MA5（但低于 MA20） |
| 空头排列 | 2 | 收盘 < MA5 + 其他 |
| 距60日高点加分 | +6 | 回落 5% 内 |
| 距60日高点加分 | +3 | 回落 5-15% |

#### 维度 4：波动率-趋势适配评分（15 分）

**波动率分类**（`volatilityClassOf()`）：从最近 20 个交易日的 `limit_up_record` 精确计数，`high`（≥3次） / `medium`（1-2次） / `low`（0次）。K 线涨跌幅不参与涨停识别。

**交叉评分矩阵**（`volatilityTrendScore()`）：

| 波动率 \ 板块趋势 | 上升 | 震荡 | 下跌 |
|:---:|:---:|:---:|:---:|
| **高** | 15 | 8 | 1 |
| **中** | 12 | 6 | 3 |
| **低** | 8 | 4 | 5 |

### 4.3 总分与策略判定

`strategyForScore(score) → { strategy_action, strategy_label, strategy_position }`

| 总分区间 | 策略动作 | 标签 | 仓位 |
|---------|---------|------|------|
| ≥ 70 | accumulate | 重点加仓 | 7-9成 |
| ≥ 55 | accumulate | 趋势跟踪 | 5-7成 |
| ≥ 40 | trade | 短线博弈 | 3-5成 |
| ≥ 25 | trade | 轻仓试探 | 1-3成 |
| ≥ 10 | reduce | 观望减仓 | 0-1成 |
| < 10 | ignore | 坚决回避 | 0成 |

### 4.4 因子存储架构

**当前实现**：SQLite `ranking_factor` 是因子主表，使用 `(date, stock_code, factor_name)` 复合主键；`stock_ranking` 保存固定字段作为向下兼容冗余表；`server/data/runtime/ranking.json` 仅保留最新排行榜缓存。

| 字段 | 说明 | 类型 | 分值 |
|------|------|------|------|
| `total_score` | 总分 | numeric | 0-100 |
| `trend_score` | 趋势评分 | numeric | 0-40 |
| `volume_price_score` | 价量评分 | numeric | 0-25 |
| `position_score` | 位置评分 | numeric | 0-20 |
| `volatility_trend_score` | 波动率适配评分 | numeric | 0-15 |
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

---

## 5. 策略回测 —— `server/backtest-engine.ts`

### 5.1 数据采集

**入口**：`collectHistoricalMarketData(rankings, options) → HistoricalMarketData | null`

**流程**：

```
1. 并发采集历史日线（Semaphore 12 → 24）
   ├─ 获取交易日历（sh000001 日线作为基准）
   └─ 并发拉取每只股票 60+70 天真实日线（多源降级链路）
   → 单事务持久化到 stock_daily_price / index_daily_price / historical_snapshot

2. 覆盖检查
   ├─ 快照需求日、实际截至日和请求交易日数匹配
   ├─ 每只股票覆盖首个信号日前 20 日预热区间及目标交易日
   └─ 全市场完整覆盖率 ≥ 20%（至少 2 只）
   → 不足则报错
```

`assessHistoricalMarketCoverage()` 会检查实际逐股 K 线日期，不再只相信 `historical_snapshot` 元数据。截面排行、回测和模拟交易执行前统一调用该检查；覆盖不足时自动运行 `collectHistoricalMarketData()` 补采，补采后再次校验，仍不足则停止后续计算或交易。

### 5.2 回测执行

**入口**：`runPolarsBacktest(history, options) → BacktestResult`

**参数配置**（`T1StrategyConfig`，`trading-strategy.ts`）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 初始资金 | 100,000 | 模拟资金 |
| 最大持仓数量 | 10 | 同时最多持仓 10 只 |
| 每日可用资金比例 | 10% | 单票最多可用资金的 10% |
| 单票最大仓位 | 10% | 单票最多总资产的 10% |
| 每日最多新增 | 2 只 | 每天最多新增 2 只持仓 |
| 止损线 | -5% | 亏损达到 5% 即卖出 |
| 止盈线 | +15% | 盈利达到 15% 即卖出 |
| 最大持有天数 | 5 天 | 到期强制卖出 |
| 滑点 | 5bps | 买入上浮 0.05%，卖出下浮 0.05% |
| 佣金 | 3bps | 最低 5 元 |
| 印花税 | 5bps | 仅卖出时收取 |

**回测主循环**：

```
for each date in 交易日:
  │
  ├─ 步骤1: 执行前一日卖出信号
  │     ├─ 遍历 pendingExits
  │     └─ 以开盘价卖出（含滑点、佣金、印花税）
  │
  ├─ 步骤2: 执行买入信号
  │     ├─ 取当日候选（前一交易日收盘信号，由 scoreStock() 生成）
  │     ├─ 检查执行日是否存在 block_top 涨停记录
  │     └─ 以开盘价买入（含滑点、佣金）
  │
  ├─ 步骤3: 检查持仓生成卖出信号
  │     ├─ 计算盈亏率 pnl_pct（参考 lastKnownClose）
  │     ├─ pnl_pct ≤ -5% → 止损卖出
  │     ├─ pnl_pct ≥ +15% → 止盈卖出
  │     └─ 持仓 ≥ 5 天 → 到期卖出
  │
  ├─ 步骤4: 记录当日净值
  │     └─ cash + positions_value → equity_curve
  │
  └─ 步骤5: 生成次日候选信号
        └─ scoreStock() 四维评分 → rankEntryCandidates() 取前 N 名
```

**买入价选择规则**：

```
始终以次日开盘价成交（简化实现）

检查执行日 `(date, stock_code)` 是否存在于 SQLite `limit_up_record`：
  - 存在 → block_top 已确认涨停，无法买入，跳过
  - 不存在 → 不以开盘涨幅或理论价格补判，继续按正常成交规则处理
```

### 5.3 回测输出

**结果结构**：

```json
{
  "run_id": "20260723_012253",
  "timestamp": "2026-07-23 01:22:53",
  "date_range": "20260701 → 20260723",
  "max_hold_days": 5,
  "engine_version": "historical-t1-v2",
  "data_source": "multi-source-qfq",
  "methodology": "当日收盘生成信号，下一交易日开盘成交",
  "bias_notes": ["股票池来自当前可用排行快照，仍可能存在幸存者偏差"],
  "summary": {
    "initial_capital": 100000.0,
    "final_capital": 105200.0,
    "total_return_pct": 5.2,
    "total_trades": 20,
    "win_rate": 65.0,
    "max_drawdown_pct": -3.5
  },
  "trades": [
    {"date": "20260701", "stock_code": "000001", "action": "买入", "price": 10.50, "shares": 900, "reason": "信号日... 排名#1 ..."},
    {"date": "20260707", "stock_code": "000001", "action": "卖出", "price": 11.20, "pnl_pct": 6.70, "reason": "止盈信号 +6.70%"},
    {"date": "20260703", "stock_code": "600036", "action": "买入", "price": 32.00, "shares": 300, "reason": "信号日... 排名#2 ..."},
    {"date": "20260708", "stock_code": "600036", "action": "卖出", "price": 30.40, "pnl_pct": -5.00, "reason": "止损信号 -5.00%"}
  ],
  "equity_curve": [
    {"date": "20260701", "cash": 100000.00, "positions_value": 0, "total": 100000.00},
    {"date": "20260702", "cash": 98950.00, "positions_value": 1050.00, "total": 100000.00},
    {"date": "20260707", "cash": 100100.00, "positions_value": 3200.00, "total": 103300.00}
  ]
}
```

---

## 6. 交易计划生成 —— `server/paper-trading.ts`

### 6.1 策略上下文构建 —— `loadPaperContext()`（`server/app.ts`）

**数据来源**：

| 数据 | 来源 | 用途 |
|------|------|------|
| 缓存分析结果 | `server/data/runtime/analysis.json` | 指数仓位建议 |
| 排行榜 | `server/data/trending.db`：`ranking_factor` + `stock_ranking` | 选股标的；`runtime/ranking.json` 仅作最新缓存 |
| 市场情绪 | `analysis.json` 中的 sentiment | 买卖门控 |
| 历史行情快照 | `server/data/trending.db`：`stock_daily_price` + `index_daily_price` + `historical_snapshot` | 收盘决策时重排行（`historicalStrategyCandidates()`） |

**大盘指数仓位映射**（`assessMarketTiming()` 在 `paper-trading.ts`）：

| 宽基指数状态 | 仓位建议 |
|-------------|---------|
| 主线主升 | 7-9成 |
| 高位滞涨 | 3-5成 |
| 首次回调 | 3-5成 |
| 箱体震荡 | 0-3成 |
| 缩量无序 | 0成 |
| 阴跌不止 | 0成 |
| 恐慌暴跌 | 0-1成 |

**市场强弱判断**（`assessMarketTiming()`）：

```
弱市条件（任一满足）：
  1. 情绪 cold
  2. 宽基指数中有处于恐慌/阴跌状态
  3. 风险指数 ≥ 30% 且 风险指数 ≥ 偏强指数

强市 → 买入开盘执行、卖出临近收盘执行
弱市 → 买入临近收盘执行、卖出开盘执行
```

### 6.2 交易计划构建 —— `buildExitSignals()` + `buildEntrySignals()`

**输入**：`PaperMarketContext`（指数仓位 + 情绪 + 排行榜 + 当前持仓 + 全市场平均涨跌幅）

**流程**：

```
PaperMarketContext
  │
  ├─ 1. 卖出信号生成（buildExitSignals）
  │     ├─ 遍历已有持仓
  │     ├─ 止损检查: pnl_pct ≤ -5% → 生成卖单（window=open）
  │     ├─ 止盈检查: pnl_pct ≥ +15% → 生成卖单（window=open）
  │     └─ 到期检查: 持仓 > 5天 → 生成卖单（window=open）
  │
  ├─ 2. 买入信号生成（buildEntrySignals）
  │     ├─ 情绪门控: cold 情绪 → 不买入
  │     ├─ 仓位门控: 当前持仓数 ≥ 目标 → 不买入
  │     ├─ 排行榜取前 N 名（maxCandidates=5）
  │     ├─ 过滤: 已持仓/block_top 确认涨停/已清仓/不满足条件
  │     ├─ 市场强 → 开盘买（window=open）
  │     └─ 市场弱 → 临收盘买（window=near_close）
  │
  └─ 3. 收盘决策（generateCloseSignals，仅 15:00 后运行）
        └─ 使用当日排行数据重新生成完整计划
```

**TradeOrder 结构**（`PaperStrategyInstruction`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `side` | str | `buy` / `sell` |
| `stock_code` | str | 6 位股票代码 |
| `stock_name` | str | 股票名称 |
| `quantity` | int | 委托数量（100 的整数倍） |
| `signal_price` | float | 信号日参考价格 |
| `reason` | str | 交易原因（止损/止盈/到期/排行等） |
| `rank` | int | 排行榜排名（仅买入） |
| `execution_window` | str | 执行窗口 `open` / `near_close` |
| `status` | str | pending/submitting/submitted/filled/skipped/failed |

### 6.3 交易参数配置

`T1StrategyConfig`（`server/trading-strategy.ts`）：

```typescript
T1StrategyConfig {
  maxHoldDays: 5,           // 最大持有天数
  maxPositions: 10,         // 最大持仓数量
  stopLossPct: -5,          // 止损线
  takeProfitPct: 15,        // 止盈线
  maxEntriesPerDay: 2,      // 每日最多新增持仓
  positionSizePct: 10,      // 单票仓位比例
  maxCandidates: 5,         // 排行榜候选数量
  lotSize: 100,             // 每手股数
  slippageRate: 0.0005,     // 滑点 5bps
  commissionRate: 0.0003,   // 佣金 3bps
  minimumCommission: 5,     // 最低佣金 5 元
  stampTaxRate: 0.0005,     // 印花税 5bps（仅卖出）
}
```

**辅助函数**（`trading-strategy.ts`）：
- `rankEntryCandidates(rows, excludedCodes, limit)` — 过滤 `accumulate`/`trade` 策略，按总分排序取前 N
- `calculateEntrySize(cash, referenceCapital, price, config)` — 计算仓位股数（含佣金）
- `exitSignalReason(pnlPct, holdDays, config)` — 止损/止盈/到期判断
- `tradingDayDistance(fromDate, toDate, calendar)` — 交易日天数（含交易日历和周末回退）

---

## 7. 同花顺客户端交易执行

### 7.1 AppleScript 桥接 —— `scripts/ths_order_dry_run.applescript`

**安全机制**：
- 只操作明确包含"模拟练习"的窗口
- 找不到即报错，不操作其他窗口
- 无法确认、字段不一致、委托回查失败立即停止

**可用命令**：

```bash
# 查询
osascript scripts/ths_order_dry_run.applescript snapshot funds     # 资金
osascript scripts/ths_order_dry_run.applescript snapshot positions # 持仓
osascript scripts/ths_order_dry_run.applescript snapshot orders    # 当日委托

# 行情
osascript scripts/ths_order_dry_run.applescript quote 600519       # 实时价格

# 交易
osascript scripts/ths_order_dry_run.applescript order buy 600519 AUTO 100   # 买入
osascript scripts/ths_order_dry_run.applescript order sell 600519 AUTO 100  # 卖出
osascript scripts/ths_order_dry_run.applescript cancel buy 600519 100       # 撤单
```

### 7.2 执行流程 —— `ThsSimulatedBroker`（`server/ths-simulated-broker.ts`）

```
ThsSimulatedBroker
  │
  ├─ snapshot()
  │     ├─ snapshot funds     → 解析资金（可用/总资产/市值）
  │     ├─ snapshot positions → 解析持仓（代码/数量/成本/现价）
  │     └─ snapshot orders    → 解析当日委托（方向/代码/数量/状态）
  │
  ├─ quote(stock_code)
  │     └─ 读取模拟交易界面中的实时价格
  │
  ├─ placeOrder(order)
  │     ├─ 提交委托（side + code + AUTO + quantity）
  │     └─ 回查确认委托成功（ORDER_VERIFIED|）
  │
  └─ cancelOrder(side, code, quantity)
        ├─ 提交撤单
        └─ 回查确认"已撤"状态（CANCEL_VERIFIED|）
```

**解析引擎**：支持表头别名匹配（中文列名如"证券代码""股票余额""成本价"）和无表头 Swift 布局两种同花顺持仓格式。

### 7.3 安全校验

```typescript
// 1. 模拟交易窗口确认
if (!output.includes("THS_SIMULATOR_V1") || !output.includes("SIMULATION|confirmed")) {
  throw new ThsSimulatedBrokerError("无法确认当前是同花顺模拟交易窗口");
}

// 2. 委托回查确认
if (!output.includes("ORDER_VERIFIED|") || !output.includes(stockCode)) {
  throw new ThsSimulatedBrokerError(`委托已提交但回查失败：${stockCode}`);
}

// 3. 撤单回查确认
if (!output.includes("CANCEL_VERIFIED|") || !output.includes(stockCode)) {
  throw new ThsSimulatedBrokerError(`撤单已操作但回查失败：${stockCode}`);
}
```

---

## 8. 自动化调度 —— `server/paper-trading.ts`

### 8.1 窗口定义

| 窗口 | 时间 | 操作 |
|------|------|------|
| **开盘窗口** | 9:31 - 10:00 | 执行卖单（止损/止盈/到期） + 买单（市场强时） |
| **临收盘窗口** | 14:55 - 15:00 | 执行买单（市场弱时） |
| **收盘决策** | 15:05+ | 采集当日排行生成次日交易计划 |
| **盘后核对** | 15:10+ | 过期信号清理 + 状态核对 |

### 8.2 调度循环

```
每 15 秒轮询一次（交易日、自动化已启用）
  │
  ├─ 判断当前属于哪个窗口
  ├─ 检查该窗口是否已触发（completed_windows 记录）
  │
  ├─ 开盘窗口:
  │     ├─ 读取账户 → 执行卖出信号
  │     └─ 如果市场强 → 执行买入信号
  │
  ├─ 临收盘窗口:
  │     └─ 如果市场弱 → 执行买入信号
  │
  ├─ 收盘决策:
  │     └─ 生成下个交易日信号（卖出+买入）
  │
  └─ 盘后核对:
        └─ 清理过期信号 + 核对持仓

  非窗口时段:
    每 60 秒执行一次账户监控
    （仅交易时段 9:25-15:20）
```

### 8.3 自动化状态持久化

存储于 `server/data/runtime/paper-trading-state.json`：

```json
{
  "schema_version": 1,
  "engine_version": "node-t1-live-v1",
  "automation": {
    "enabled": false,
    "paused_today": false,
    "next_window": "下一窗口：09:31 开盘执行"
  },
  "reference_capital": 100000.00,
  "completed_windows": {
    "20260723": ["open", "close"],
    "20260722": ["open", "near_close", "close", "post_close"]
  },
  "instructions": [],
  "tracked_positions": [],
  "events": [],
  "last_account_observation": {},
  "last_signal_date": "20260722",
  "updated_at": "2026-07-23 09:31:05"
}
```

- `enabled=false` 为默认安全状态，需前端手动启用
- `completed_windows` 记录已触发窗口，防重启重复触发
- `paused_today` 暂停当天剩余窗口
- 服务重启时，`submitting` 状态的指令自动标记为 `uncertain`，需人工核对

---

## 9. 持仓盈亏监控

### 9.1 实时监控 —— `PaperTradingService.monitorAccount()`

**每 60 秒**轮询同花顺持仓，计算：

- 单票盈亏额：`(current_price - cost_price) × quantity`
- 单票盈亏率：`(current_price - cost_price) / cost_price × 100%`
- 账户汇总盈亏：`sum(各票盈亏额) + 可用资金 - 总资产`

**变动识别**（`observeAccountChanges()`）：

| 事件 | 识别方式 | 处理 |
|------|---------|------|
| 行情波动 | 数量不变、成本不变 | 更新现价/盈亏，正常推送 |
| 委托成交 | 持仓数量变化 | 更新持仓，标记为策略成交 |
| 人工操作 | 新股票出现或数量变化 | 标记 `source=reconciled`，重建策略计划 |

### 9.2 WebSocket 推送 —— `server/index.ts`

**端点**：
- `/ws/tasks` — 异步任务进度推送（`TaskRegistry` 事件）
- `/ws/simulated-trading` — 模拟交易状态推送（`PaperTradingService` 事件）

**连接建立**：
```
taskSockets: 连接时发送全量快照，后续增量推送
paperSockets: 连接时发送 { type: "status", connected: true }，后续事件推送
```

**推送数据**（模拟交易）：

```json
{
  "type": "window_done",
  "window": "open",
  "results": [...],
  "message": "2026-07-23 开盘窗口完成，处理 2 笔策略指令"
}
```

```json
{
  "type": "automation",
  "automation": { "enabled": true, "paused_today": false, "next_window": "下一窗口：14:55 临收盘执行" },
  "schedule": [...]
}
```

---

## 10. 完整流程串联

### 10.1 每日流程时序

```
交易日 9:00
  │
  ├─ [15:05 收盘后] 采集涨停数据 → 板块 K 线 → 趋势分类 → 计算排行榜
  │    调用 POST /api/analysis/collect 触发完整流水线
  │    （fetchBlockTop → fetchBlockKlines → analyzeBlockTrend → refreshAnalysis）
  │
  ├─ [9:31 开盘窗口]
  │     ├─ 读取账户（资金/持仓/委托）
  │     ├─ 加载策略上下文（指数仓位 + 情绪 + 排行榜）
  │     ├─ 执行卖出信号（止损/止盈/到期）
  │     └─ 如果市场强 → 执行买入信号
  │
  ├─ [每 15 秒] 调度循环 & WebSocket 推送
  │
  ├─ [14:55 临收盘窗口]
  │     └─ 如果市场弱 → 执行买入信号
  │
  ├─ [15:05 收盘决策]
  │     ├─ 拉取实时排行数据（或调用 collectHistoricalMarketData 重排行）
  │     └─ 生成次日交易计划（卖出+买入信号）
  │
  ├─ [15:10 盘后核对]
  │     └─ 清理过期信号 + 核对持仓状态
  │
  └─ [每 60 秒，9:25-15:20] 账户监控
        └─ 读取同花顺持仓变化 → WebSocket 广播
```

### 10.2 数据流全景

```
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                        同花顺客户端                                 │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │                    模拟练习窗口                              │   │
                   │  │  资金/持仓/委托 ←─ AppleScript ── broker.snapshot()          │   │
                   │  │  提交委托    ←─ AppleScript ── broker.placeOrder()           │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   └─────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ osascript
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  server/paper-trading.ts                                    │   │
                   │  │  ┌────────────────┐  ┌────────────────┐  ┌───────────────┐  │   │
                   │  │  │ 策略上下文     │  │ 交易计划生成   │  │ 执行引擎      │  │   │
                   │  │  │ loadPaperContext│→│ buildExit/    │→│ runWindow     │  │   │
                   │  │  │                │  │ EntrySignals   │  │ executePlanned│  │   │
                   │  │  └────────────────┘  └────────────────┘  └───────────────┘  │   │
                   │  │                                                                 │
                   │  │  ┌──────────────────────────────────────────────────────────┐   │
                   │  │  │ 调度循环 (15s) + 账户监控 (60s) + WebSocket 广播         │   │
                   │  │  │ tickScheduler()  monitorAccount()  broadcast()          │   │
                   │  │  └──────────────────────────────────────────────────────────┘   │
                   │  └─────────────────────────────────────────────────────────────────┘
                   │                                                                     │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  server/ths-simulated-broker.ts (AppleScript 桥接层)          │   │
                   │  │  parseThsFundsSnapshot  parseThsPositionsSnapshot             │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   └─────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ 调用
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                      业务逻辑层                                     │
                   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
                   │  │ scoring-    │  │ polars-      │  │ backtest-    │               │
                   │  │ engine.ts   │  │ engine.ts    │  │ engine.ts   │               │
                   │  │ 四维评分     │  │ 排行榜查询   │  │ 回测引擎     │               │
                   │  │ 七态分类     │  │ 排序/筛选    │  │ 历史评分     │               │
                   │  │ 板块趋势分析 │  │ 情绪聚合     │  │ (调scoring)  │               │
                   │  └──────────────┘  └──────────────┘  └──────────────┘               │
                   │  ┌──────────────┐  ┌──────────────┐                                 │
                   │  │ historical-  │  │ app.ts       │  ┌──────────────┐               │
                   │  │ market.ts    │  │ API 路由     │  │ trading-     │               │
                   │  │ 真实日线采集  │  │ 任务注册     │  │ strategy.ts  │               │
                   │  │ 多源K线+涨停  │  │ 涨停采集流水线│  │ 选股/仓位    │               │
                   │  │ 板块K线+涨停  │  │ 审计日志     │  │ 止盈止损     │               │
                   │  └──────────────┘  └──────────────┘  └──────────────┘               │
                   └─────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ 读写
                   ┌─────────────────────────────────────────────────────────────────────┐
                   │                    数据持久层 (SQLite + JSON)                      │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  server/data/trending.db  (`node:sqlite`, WAL)               │   │
                   │  │  股票/板块/涨停/行情/趋势/排行榜因子                         │   │
                   │  │  ranking_factor 主表 + stock_ranking 兼容表                  │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   │                                                                     │
                   │  ┌──────────────────────────────────────────────────────────────┐   │
                   │  │  JSON 缓存与归档                                              │   │
                   │  │  analysis.json / runtime/ranking.json                        │   │
                   │  │  runtime/paper-trading-state.json                            │   │
                   │  │  backtests/*.json / runtime/backtests/*.json                 │   │
                   │  │  runtime/logs/*.jsonl / deleted-backtests.json               │   │
                   │  └──────────────────────────────────────────────────────────────┘   │
                   └─────────────────────────────────────────────────────────────────────┘
```

### 10.3 Web 界面映射

| 页面 | 路由 | 对应功能 | 组件 |
|------|------|---------|------|
| 首页 | `/` | 指数趋势 + 板块情绪一览 | `HomePage.tsx` |
| 详情页 | `/details` | 板块涨停个股明细 + K 线 | `DetailsPage.tsx` |
| 排行榜 | `/ranking` | 多因子评分排行（搜索/筛选/排序） | `RankingPage.tsx` |
| 回测 | `/backtest` | 策略回测与结果展示（净值曲线） | `BacktestPage.tsx` |
| 模拟交易 | `/simulated-trading` | 资金/持仓/计划/委托/执行 | `SimulatedTradingPage.tsx` |

---

## 11. CLI / API 操作速查

### 11.1 启动服务

```bash
npm run dev          # 开发模式（API + Vite 并行）
npm run start        # 生产模式启动（端口 8787）
npm run dev:api      # 仅 API 服务器（热重载）
npm run dev:web      # 仅前端开发服务器

npm test             # 运行测试
npm run test:watch   # 监听模式测试
```

要求 Node.js `>=22.13.0`。`server/data/` 整体在 `.gitignore` 中，仓库不再携带任何市场数据、账户状态或回测结果。首次创建 `DataStore` 时会自动建立 `server/data/trending.db`、启用 WAL/外键并幂等执行 v1.4 表结构；没有外部数据时 API 返回空快照，随后可通过采集接口填充。若用户自行放入旧版 `ranking.json` / `historical-market.json`，仍会兼容导入。

### 11.2 SQLite 运维

```bash
# 查看表与索引
sqlite3 server/data/trending.db '.tables'
sqlite3 server/data/trending.db 'PRAGMA journal_mode; PRAGMA foreign_keys; PRAGMA user_version;'

# 在线安全备份（推荐）
sqlite3 server/data/trending.db ".backup 'server/data/trending.db.backup'"
```

`GET /api/health` 的 `storage` 字段同时返回数据库路径、WAL 状态、外键状态、`busy_timeout`、同步级别、schema version 和表清单。

### 11.3 API 端点

```bash
# ==== 健康检查 ====
GET /api/health

# ==== 分析数据 ====
GET /api/analysis                    # 获取指数+板块分析
GET /api/analysis?refresh=1          # 异步采集 blocktop+板块/个股/指数并刷新分析
POST /api/analysis/collect           # 同上，保留主动采集语义

# ==== 板块数据 ====
GET /api/limit_up?date=20260723      # 板块涨停明细（扁平化）
GET /api/block_prices?block_code=881145&period=01&limit=120  # 板块K线

# ==== 个股行情 ====
GET /api/stock_prices?stock_code=000001&limit=60  # K线+MA5/10/20
GET /api/klines?symbol=sh000001&limit=120         # 原始K线数据
GET /api/index_prices?symbol=sh000001&limit=120   # 指数K线

# ==== 排行榜 ====
GET /api/ranking                     # 查询排行榜（搜索/筛选/排序/分页）
POST /api/ranking/compute            # 校验/补采需求日期行情后异步重算截面排行

# ==== 回测 ====
POST /api/backtest/collect?days=20   # 采集历史数据
POST /api/backtest/run?days=20       # 校验/补采所需区间后运行回测
GET /api/backtest/list               # 回测列表
GET /api/backtest/:runId             # 回测详情
DELETE /api/backtest/:runId          # 删除回测

# ==== 模拟交易 ====
GET /api/simulated-trading/health
GET /api/simulated-trading/bootstrap      # 快速初始化（无实时账户同步）
GET /api/simulated-trading/overview       # 完整账户+计划
GET /api/simulated-trading/automation     # 自动化状态
GET /api/simulated-trading/state          # 运行时状态
POST /api/simulated-trading/execute       # 执行计划（--confirm SIMULATED）
POST /api/simulated-trading/cancel        # 撤单
POST /api/simulated-trading/automation/toggle  # 启用/禁用自动化
POST /api/simulated-trading/automation/pause-today  # 暂停当天
POST /api/simulated-trading/automation/resume       # 恢复
POST /api/simulated-trading/automation/run-window   # 手动执行窗口（--confirm SIMULATED）
POST /api/simulated-trading/monitor/run   # 手动执行账户监控

# ==== 审计日志 ====
GET /api/audit/logs?level=error&component=paper_trading
GET /api/audit/files

# ==== 异步任务 ====
GET /api/tasks                    # 任务列表
GET /api/tasks/:taskId            # 任务详情
POST /api/tasks/:taskId/cancel    # 取消任务

# ==== WebSocket ====
ws://localhost:8787/ws/tasks              # 任务进度推送
ws://localhost:8787/ws/simulated-trading  # 模拟交易状态推送
```

---

## 12. 服务器模块一览

| 模块 | 文件 | 职责 |
|------|------|------|
| API 路由 | `server/app.ts` | Express 路由、中间件、服务组合、涨停采集流水线 |
| 服务入口 | `server/index.ts` | HTTP + WebSocket 服务器启动 |
| 混合数据存储 | `server/data-store.ts` | SQLite 门面、旧 JSON 种子迁移、缓存/状态/回测归档 |
| SQLite 仓储 | `server/sqlite-store.ts` | `node:sqlite` 建表迁移、WAL、事务批量 upsert、结构化查询 |
| 行情采集 | `server/historical-market.ts` | 多源 K 线、板块 K 线、涨停排行采集 |
| 评分引擎 | `server/scoring-engine.ts` | 四维多因子评分、七态市场分类、板块趋势分析、策略矩阵 |
| 排行榜查询 | `server/polars-engine.ts` | 排行榜查询/排序/筛选、情绪聚合、重算 |
| 交易策略 | `server/trading-strategy.ts` | 参数配置、选股过滤、仓位计算、止盈止损；不负责涨停判定 |
| 回测引擎 | `server/backtest-engine.ts` | 历史回测、日内循环、评分驱动 |
| 模拟交易 | `server/paper-trading.ts` | 交易计划、执行、调度、监控 |
| 同花顺桥接 | `server/ths-simulated-broker.ts` | AppleScript 调用、持仓解析 |
| 审计日志 | `server/audit-log.ts` | JSONL 日志、查询、轮转 |
| 任务注册 | `server/tasks.ts` | 异步任务管理、进度跟踪、WebSocket 广播 |
| 格式化 | `server/format.ts` | 日期、数字工具函数 |
| AppleScript | `scripts/ths_order_dry_run.applescript` | 同花顺模拟练习 GUI 操作 |
| 开发脚本 | `scripts/dev.mjs` | 并行启动 API + Vite 开发服务器 |

---

## 13. 关键设计原则

### 13.1 无未来函数

所有回测和策略计算严格按日期过滤：

```typescript
// 回测中按日期截断，不窥视未来数据
const barIndex = series.indexByDate.get(date);
if (barIndex == null || barIndex < 19) return null;
// 只使用截至该日期的 K 线计算指标
const closes = bars.slice(0, barIndex + 1).map((bar) => bar.close);
```

### 13.2 安全优先

```
模拟交易安全链：
1. 默认只读（自动化默认关闭，enabled=false）
2. 显式确认词（--confirm SIMULATED / CANCEL）
3. 窗口时间校验（仅允许在交易时段执行）
4. AppleScript 窗口校验（只操作模拟练习窗口）
5. 委托回查（提交后确认是否成功）
6. 撤单回查（操作后确认状态）
7. 服务重启 → 提交中指令标记为 uncertain
```

### 13.3 缓存分层

| 层级 | 数据 | 有效期 |
|------|------|--------|
| SQLite | 股票/板块/涨停/日行情/板块趋势/排行因子 | 结构化持久化，数据库为准 |
| 基础目录 | `analysis.json` / `ranking.json` | 首次启动兼容导入种子 |
| 运行时缓存 | `analysis.json` / `ranking.json` | 最新计算结果缓存，可重建 |
| 状态文件 | 自动化状态、交易日志 | 持久化，跨重启 |
| 内存字典 | 回测预加载 | 回测期间 |

### 13.4 限流保护

| 接口 | 限流方式 | 并发限制 |
|------|---------|---------|
| 同花顺板块 K 线 | 并发采集 | 6 |
| 腾讯财经个股行情 | 单请求 | 1 |
| 历史数据采集 | Semaphore | 24 |
| WebSocket 广播 | 事件驱动 | 无限制 |
| AppleScript 调用 | 操作队列串行 | 1 |

---

## 14. 审计日志 —— `server/audit-log.ts`

每个重要操作都有审计记录，存储为 `data/runtime/logs/quant-audit-YYYYMMDD.jsonl`。

**日志级别**：`debug` | `info` | `warn` | `error`

**关键审计事件**：

| 组件 | 事件 | 级别 |
|------|------|------|
| `http` | request_started / completed / failed | info / error |
| `market_data` | collection_started / completed / failed / snapshot_saved / stock_loaded / stock_fetch_failed | info / error |
| `market_analysis` | analysis_refreshed / limit_up_collected / limit_up_collection_empty | info / warn |
| `factor_ranking` | ranking_started / completed / historical_ranking_completed | info |
| `backtest` | run_started / completed | info |
| `paper_trading` | window_started / completed / failed | info / error |
| `strategy` | close_evaluation / entry_candidate | debug |
| `order` | submission_started / verified / uncertain | info / error |
| `account_monitor` | account_changed / monitor_failed | info / error |
| `ths_broker` | snapshot_parsed / order_verified | info |
| `ths_applescript` | command_started / completed / failed | info / error |

---

## 15. 常见问题排查

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| 分析数据为空 | 未导入 `analysis.json` | 将预生成文件放入 `server/data/`，或调用 `POST /api/analysis/collect` 采集 |
| 排行榜为空 | SQLite 尚无排行且未提供兼容种子 | 将 `ranking.json` 放入 `server/data/` 触发首次导入，或调用 `POST /api/ranking/compute` |
| SQLite 无法启动 | Node 版本过低 | 升级到 Node.js 22.13+；项目直接使用内置 `node:sqlite`，不需要安装原生依赖 |
| 行情接口网络失败 | 腾讯/新浪/东方财富暂时不可用 | 已落库的个股/指数 K 线会自动从 `stock_daily_price` / `index_daily_price` 回退 |
| 同花顺 AppleScript 失败 | 未打开模拟练习窗口 | 打开同花顺 → 模拟练习 |
| 委托回查失败 | 界面未更新 / 弹窗遮挡 | 检查同花顺界面状态 |
| 自动化调度不执行 | 未启用 | 前端调用 `POST /api/simulated-trading/automation/toggle` |
| 回测失败 | 历史数据不足 | 先调用 `POST /api/backtest/collect` |
| 涨停采集返回空 | 同花顺反爬拦截 | 检查网络，保留现有 `analysis.json` 快照 |
| 服务启动报错 | 端口被占用 | 检查 8787 端口，或设置 `PORT` 环境变量 |

---

## 16. 与 Python 原始版的关键差异

| 维度 | Python 版 | TypeScript 版 |
|------|-----------|---------------|
| 语言 | Python 3.12+ | TypeScript 5+ / Node.js 22.13+ |
| 数据采集 | 同花顺涨停排行主动采集 | ✅ 板块 K 线 ✅ 个股行情 ✅ 涨停排行（`fetchBlockTop()`） |
| 涨停采集 | 本地实现 | ✅ `fetchBlockTop()` + `parseBlockTop()` 实时采集，Network fallback 到预生成数据 |
| 趋势分析 | 本地计算七种状态分类 | ✅ `classifyMarketState()` 本地计算（`scoring-engine.ts`） |
| 板块趋势 | 本地计算 | ✅ `analyzeBlockTrend()` 本地计算 + 周/月线交叉验证 |
| 数据存储 | SQLite + CSV | ✅ 内置 `node:sqlite` + JSON 缓存/归档；WAL、外键、批量事务 |
| 排行榜 | 两阶段计算 + KV 存储 | ✅ `ranking_factor` KV 主表 + `stock_ranking` 兼容表；核心评分引擎支持回测与实时双路径 |
| 评分架构 | 内联在回测中 | ✅ 独立 `scoring-engine.ts`，回测（`scoreStock()`）和实时路径共享同一份评分逻辑 |
| 价量评分 | 简单规则 | ✅ 14 种精细分类（`volumePriceScore()`） |
| 波动率-趋势矩阵 | 固定 8 分 | ✅ 完整 3×3 交叉评分矩阵（`volatilityTrendScore()`） |
| 板块加分 | 无 | ✅ `scoreStock()` 支持 `SectorContext` 传入，趋势评分加/减 ±4 分 |
| 回测 | 按市场强弱决定开盘/收盘买 | 始终开盘买（简化），使用 `scoreStock()` 统一评分 |
| 停牌处理 | 跳过 | ✅ 开盘价≤0 时跳过；涨停只按 block_top 记录过滤 |
| 交易策略 | 内联 | ✅ 独立 `trading-strategy.ts`：`rankEntryCandidates()` / `calculateEntrySize()` / `exitSignalReason()` |
| Web 框架 | Flask | Express 5 |
| 前端 | Jinja2 模板 | React 19 + Tailwind CSS |
| 实时推送 | 无 | ✅ WebSocket 双通道（`/ws/tasks` + `/ws/simulated-trading`） |
| 任务管理 | 无 | ✅ 异步任务注册 + 进度追踪 + WebSocket 广播 |
| 审计日志 | 无 | ✅ JSONL 结构化审计（`audit-log.ts`） |
| 复权处理 | 外部数据源 pre-QFQ | 腾讯 qfqday / 新浪自行复权 / 东方财富前复权 |
| 涨停判定 | 价格幅度推断 | ✅ 仅同花顺 `block_top` / SQLite `limit_up_record`，禁止按涨幅反推 |
