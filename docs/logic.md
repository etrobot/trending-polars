# 业务逻辑

> 行情趋势分析、多因子评分、策略回测、交易计划生成与自动化调度。

---

## 1. 行情趋势分析与策略分类

### 1.1 指数趋势分析 —— `server/scoring-engine.ts` + `server/polars-engine.ts`

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

### 1.2 板块趋势分析 —— `server/scoring-engine.ts`

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

### 1.3 板块策略矩阵 —— `server/scoring-engine.ts`

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

### 1.4 市场情绪分类 —— `server/polars-engine.ts`

**实现**：`refreshAnalysis()` 中的实时计算

**阈值规则**：

| 情绪 | 条件 | 行为 |
|------|------|------|
| `hot` | 涨停总数 ≥ 80 | 积极做多，可参与热点板块 |
| `normal` | 涨停总数 30-79 | 正常交易，精选个股 |
| `cold` | 涨停总数 < 30 | 谨慎观望，降低仓位 |

---

## 2. 个股因子评分 —— `server/scoring-engine.ts`（核心引擎）+ `server/backtest-engine.ts`（回测驱动）

### 2.1 两阶段计算架构

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

### 2.2 评分维度详解

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

### 2.3 总分与策略判定

`strategyForScore(score) → { strategy_action, strategy_label, strategy_position }`

| 总分区间 | 策略动作 | 标签 | 仓位 |
|---------|---------|------|------|
| ≥ 70 | accumulate | 重点加仓 | 7-9成 |
| ≥ 55 | accumulate | 趋势跟踪 | 5-7成 |
| ≥ 40 | trade | 短线博弈 | 3-5成 |
| ≥ 25 | trade | 轻仓试探 | 1-3成 |
| ≥ 10 | reduce | 观望减仓 | 0-1成 |
| < 10 | ignore | 坚决回避 | 0成 |

---

## 3. 策略回测 —— `server/backtest-engine.ts`

### 3.1 数据采集

**入口**：`collectHistoricalMarketData(rankings, options) → HistoricalMarketData | null`

**流程**：

```
1. 并发采集历史日线（Semaphore 12 → 24）
   ├─ 获取交易日历（sh000001 日线作为基准）
   └─ 并发拉取每只股票 60+70 天真实日线（多源降级链路）
   → 单事务持久化到 stock_daily_price / index_daily_price / historical_snapshot

2. 回测时段涨停记录采集
   ├─ 遍历回测日期范围内的每个交易日
   ├─ 调用 fetchBlockTop(date) 获取当日 block_top 数据
   └─ 写入 HistoricalMarketData.limit_up_records
   （可传入 existingLimitUpRecords 跳过网络请求，从 SQLite 已有数据加载）

3. 回测时段板块指数 K 线采集
   ├─ 从涨停记录中提取出现过的板块代码
   ├─ 调用 fetchBlockKlines(code, "01", 250) 获取板块日线
   └─ 写入 HistoricalMarketData.blocks
   （可传入 existingBlockSeries 跳过网络请求）

4. 覆盖检查
   ├─ 快照需求日、实际截至日和请求交易日数匹配
   ├─ 每只股票覆盖首个信号日前 20 日预热区间及目标交易日
   └─ 全市场完整覆盖率 ≥ 20%（至少 2 只）
   → 不足则报错
```

`assessHistoricalMarketCoverage()` 会检查实际逐股 K 线日期，不再只相信 `historical_snapshot` 元数据。截面排行、回测和模拟交易执行前统一调用该检查；覆盖不足时自动运行 `collectHistoricalMarketData()` 补采，补采后再次校验，仍不足则停止后续计算或交易。

### 3.2 回测执行

**入口**：`runPolarsBacktest(history, options) → BacktestResult`

**评分架构**：`backtest-scoring.ts` 的向量化预计算 + `backtest-engine.ts` 的日内循环。

#### 3.2.1 向量化评分预计算 —— `backtest-scoring.ts`

不再使用逐日逐股调用 `scoreStock()` 的循环，改为在回测启动前通过 `computeBacktestScores()` 单次 Polars 遍历计算全量「股票 × 日期」评分矩阵。

**流程**：

```
1. 板块趋势滚动计算（computeSectorStates）
   ├─ 遍历 HistoricalMarketData.blocks（板块指数日线）
   └─ 对每个板块在每个回测日期调用 classifyMarketState() 获取当日状态
   → 返回 Map<sector_code, Map<date, state_id>>

2. 构建扁平化列数组
   ├─ 展开所有股票的所有 K 线为列数组（stock_code, date, open, close, ...）
   ├─ computeStockArrays() 计算 trend_strength（滚动线性回归斜率/均价）和涨停标记
   └─ 通过 sector_history 查找每个日期最近的前 past block_top 记录确定板块归属

3. 单次 Polars DataFrame 运算
   ├─ 滚动窗口：MA5/10/20/60、量比、60日高点、20日涨停计数
   ├─ 均线排列分类（bullish/bearish/tangled）
   ├─ 四维评分：趋势(40) + 价量(25) + 位置(20) + 波动率(15)
   └─ 策略分类（accumulate/trade/reduce/ignore）

4. 按日期分组，排序编号
   → 返回 Map<date, RankingRow[]>
```

**性能优势**：O(N) 单次遍历 vs O(D × S) 逐日逐股循环（D=交易日数，S=股票数）。Polars 的列式运算比 JS 手写循环在数据量大时效率更高。

#### 3.2.2 日内循环

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
  │     ├─ 取当日候选（从预计算 scoreMap.get(date) 获取向量化评分结果）
  │     ├─ rankEntryCandidates() 过滤 accumulate/trade 策略，按总分排序取前 N
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
        └─ 从预计算 scoreMap.get(date+1) 获取次日评分 → rankEntryCandidates() 取前 N 名
```

**买入价选择规则**：

```
始终以次日开盘价成交（简化实现）

检查执行日 `(date, stock_code)` 是否存在于 SQLite `limit_up_record`：
  - 存在 → block_top 已确认涨停，无法买入，跳过
  - 不存在 → 不以开盘涨幅或理论价格补判，继续按正常成交规则处理
```

### 3.3 回测输出

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

## 4. 交易计划生成 —— `server/paper-trading.ts`

### 4.1 策略上下文构建 —— `loadPaperContext()`（`server/app.ts`）

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

### 4.2 交易计划构建 —— `buildExitSignals()` + `buildEntrySignals()`

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
  │     ├─ 过滤: 已持仓/已清仓/不满足条件
  │     ├─ 市场强 → 开盘买（window=open）
  │     └─ 市场弱 → 临收盘买（window=near_close）
  │     （注：不再过滤 block_top 涨停股，由执行时的 broker 实际拒绝处理）
  │
  ├─ 3. 收盘决策（generateCloseSignals，仅 15:00 后运行）
  │     └─ 使用当日排行数据重新生成完整计划
  │
  └─ 4. 收盘自动生成（ensureSameDayCloseSignals，15:00+）
        └─ 当排行截面日期=当天且尚未生成信号时，主动调用 generateCloseSignals()
        └─ 解决自动化关闭时 overview 不产生计划的场景
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

### 4.3 交易参数配置

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

## 5. 自动化调度 —— `server/paper-trading.ts`

### 5.1 窗口定义

| 窗口 | 时间 | 操作 |
|------|------|------|
| **开盘窗口** | 9:31 - 10:00 | 执行卖单（止损/止盈/到期） + 买单（市场强时） |
| **临收盘窗口** | 14:55 - 15:00 | 执行买单（市场弱时） |
| **收盘决策** | 15:05+ | 采集当日排行生成次日交易计划 |
| **盘后核对** | 15:10+ | 过期信号清理 + 状态核对 |

### 5.2 调度循环

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

### 5.3 自动化状态持久化

存储于 `server/data/runtime/paper-trading-state.json` 和 SQLite `paper_instruction` 表：

- **状态文件**（JSON）：自动化开关、已完成窗口、参考资金、账户快照等
- **指令持久化**（SQLite）：`paper_instruction` 表保存所有指令，`getPaperTradingState()` 读取时自动从 JSON 迁移旧数据到 SQLite，后续以 SQLite 为权威来源
- `savePaperTradingState()` 同时写入 JSON 和 SQLite，保持双写一致性

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
