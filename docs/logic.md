# 业务逻辑

> 行情趋势分析、多因子评分、策略回测、交易计划生成与自动化调度。

---

## 1. 行情趋势分析与策略分类

### 1.1 评分参数配置化

评分引擎和向量化回测已支持参数化配置，便于参数优化和自定义策略。

**核心类型**：`ScoreStockConfig`（`server/scoring-engine.ts`），包含：

| 配置域 | 字段 | 含义 |
|--------|------|------|
| `distanceFromLow` | `tiers[]`, `atLowScore`, `extendedScore` | 距 60 日低点评分的分档阈值和分值 |
| `trend` | `bullishAlignment`, `trendBonusMultiplier`, `trendStrengthThreshold`, `sectorUpBonus` | K 线趋势评分参数 |
| `volatilityTrend` | `limitUp.highMinLimitUps`, `matrix` | 波动率分类阈值和交叉评分矩阵 |
| `relativeStrength` | `lookback`, `floorPct`, `capPct`, `maxScore` | 维度 5 相对强度的窗口与映射区间 |
| `sectorStrategy` | `scores`, `stableTrend`, `breakout`, `panic`, `rebound`, `caps` | 板块趋势 × 个股形态的情境加减分与阈值 |
| `marketState` | `MarketStateThresholds` 全部字段 | 八态分类阈值（ADX 门槛、量比、筑底确认数…） |

> `marketState` 挂在 `ScoreStockConfig` 上，是为了复用既有的「配置 → SQLite → 回测/实盘两条打分路径」的传递链路，
> 而不是另造一套。此前 `MarketStateThresholds` 虽然定义了类型，却没有任何调用方能把它传进 `analyzeBlockTrend`，
> `singlePeriodTrend` 里的 `15 / 0.003 / 3`、`classifyMarketState` 里的 `0.9` 也都是裸魔数 —— 现已全部收编。
>
> 该组阈值**未**纳入参数优化的搜索网格：再加 8 个维度会让网格爆炸，也会加剧正是 §3.5 想要对抗的过拟合。

**默认配置**：`DEFAULT_SCORE_STOCK_CONFIG`，可在 `ScoreStockConfig` 基础上通过 `normalizeScoreStockConfig(overrides)` 覆盖，生成完整配置副本。

**入口**：`scoreStock(series, date, sector?, config?)` 和 `computeBacktestScores(history, dates, limitUpDates, scoringConfig?)` 均接受可选 `config` 参数，默认使用 `DEFAULT_SCORE_STOCK_CONFIG`。

### 1.2 指数趋势分析 —— `server/scoring-engine.ts` + `server/polars-engine.ts`

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

**七种市场状态**（实际引擎加上 0/8，一共暴露 9 类，详见下方表格）：

| ID | 名称 | 趋势 | 仓位建议 | 信号 |
|----|------|------|---------|------|
| 0 | 数据不足 | 未知 | 0成 | empty |
| 1 | 主线主升 | 上升 | 7-9成 | buy |
| 2 | 高位滞涨 | 上升 | 3-5成 | sell |
| 3 | 首次回调 | 上升 | 3-5成 | sell |
| 4 | 箱体震荡 | 横盘 | 0-3成 | hold |
| 5 | 缩量无序 | 横盘 | 0成 | empty |
| 6 | 阴跌不止 | 下跌 | 0成 | empty |
| 7 | 恐慌暴跌 | 下跌 | 0-1成 | empty |
| 8 | 筑底成功 | 横盘 | 1成 | buy |

**分类规则**（`classifyMarketState()`，阈值全部来自 `MarketStateThresholds`）：
- 上升趋势：`bullish` 排列，或 `trendStrength > 0.003` **且** ADX 确认（`adx ≥ 20` 且 `+DI − -DI > 3`）
  - 距高点 3% 内 → 量比 ≥ 0.9（`risingVolumeRatio`）为主线主升，否则高位滞涨
  - 距高点 ≥ 5% → 首次回调
  - 中间带 −5% ~ −3% → **同样做量能检验**（曾经无条件判主线主升，导致 −2% 缩量判卖出、−4% 缩量判七九成买入的悬崖）
- 下跌趋势：`bearish` 排列，或 `trendStrength < -0.003` 且 ADX 确认反向。5 日跌幅≥8% 或波动率≥4.5 → 恐慌暴跌；否则 → 阴跌不止
- 横盘：量比<0.8 → 缩量无序；否则 → 箱体震荡
- **筑底成功**（state 8）：不上升 + 5 日涨幅 ∈ [2%, 8%] + 量比≥1.1 + 距高点 ≤-8% + 趋势强度>-0.005，**并且**通过底部反转确认

> **ADX 预热保护**：`computeADX` 需要 `period × 2 = 28` 根 K 线才完成 Wilder 预热，未预热时返回 `warm: false`。
> 此时 ADX **不构成否决条件**，趋势判定退回纯斜率 —— 否则样本刚够 20 根的板块会被系统性压成震荡市。

> **底部反转确认**（`bottomingConfirmations`）：区分「筑底成功」与「下跌中继反抽」。
> state 8 按设计就发生在均线仍空头排列的结构里，不能用 `!falling` 简单排除，真正的分水岭是方向是否已转折。
> 四项证据分两类：
> - 动量类：收盘站上 MA5、-DI 收敛（`direction > -10`）。**一根长阳就能同时点亮两项**（实测阴跌中插入 +8.5% 假反弹即可）。
> - 结构类：MA5 掉头向上、低点抬高（最近 5 日最低 > 前 10 日最低）。需要连续多根 K 线配合，单根脉冲伪造不出来。
>
> 判定要求「总数 ≥ `bottomingMinConfirmations`（默认 2）**且** 结构类 ≥ 1」。

> `state_id=8` 在表 `sector_trend_daily` 由 v18 起不再被 CHECK 约束拒绝；`server/sqlite/helpers.ts` 的 `STATE_NAMES` 与 `scoring-engine.ts` 的 `STATE_TABLE` 同步暴露该状态。

### 1.3 板块趋势分析 —— `server/scoring-engine.ts`

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
       ├─ 日线上升 + 周月均下跌 → 降级为「阴跌不止」（adjust_direction='down'）
       ├─ 日线 state 8 + 周月均下跌 → 抑制为「阴跌不止」（adjust_direction='down'）
       ├─ 日线下跌 + 周月均上升 → 升级为「筑底成功」（adjust_direction='up'）
       └─ 其他情况 → 正常使用日线状态
```

**周/月线最小样本**：`MIN_HIGHER_TIMEFRAME_BARS = 28`（ADX 预热长度）。
过去的门槛是 14 根 —— 而 14 根恰好让 `computeADX` 返回 0 从而永远判 `range`，15~27 根则输出未预热的噪音值，门槛形同虚设却又不可信。

**窗口一致性**：日线取 `SECTOR_STATE_WINDOW_BARS = 120` 根、周月线取 `HIGHER_TIMEFRAME_WINDOW_BARS = 60` 根，
**实盘与回测两条路径必须取同一值**。ADX 的 Wilder 平滑是路径依赖的（IIR）：同一根 K 线喂 60 根和喂 250 根历史会给出不同 ADX，
可能跨过 `adxTrending` 门槛得到不同 `state_id`，回测结论就无法外推到实盘。

**输出字段**：`state_id`, `state_name`, `trend`, `position`, `signal`, `latest`, `ma5`, `ma20`, `near_high`, `volume_trend`,
`adx`, `plus_di`, `minus_di`, `adjusted?`, `adjust_direction?`, `downgraded?`, `original_state_id?`, `confirmations?`, `higher_timeframe?`

> `downgraded` 只在**降级**时为 true；升级请读 `adjusted` + `adjust_direction`。
> 旧实现两种情况都写 `downgraded=true`，审计时分不清方向。
> `confirmations` 标明周/月线是否真的参与判定 —— 仅由日线得出的状态可信度较低。

### 1.4 板块策略矩阵 —— `server/scoring-engine.ts`

**接口**：`blockStrategy(stateId, limitUpNum, maxContinue, context?) → BlockStrategy`

**热度判定**（`isHotBlock`）：连板高度 ≥ 2，且涨停家数 ≥ **随市场温度缩放**的门槛
（全市场涨停总数 × 12%，钳制在 3~8 家）。冷市场（全市场 30 家）4 家即达标，热市场（120 家）需要 8 家。
不传 `marketLimitUpTotal` 时退回固定阈值 5。旧实现用固定 5 家一刀切，冷热市场的同一个数字含义完全不同。

**多周期正向共振**：`context.higherTimeframe` 显示周月线同时向上时，仓位在
`0成 → 0-1成 → 1成 → 0-3成 → 3-5成 → 7-9成` 的梯子上**上调一档**。
负向背离不在这里再减一档 —— 那已由 `analyzeBlockTrend` 改写 `state_id` 处理过，重复扣会把同一信号计两次。

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
| 8-筑底成功 | 筑底成功 1成 | 筑底成功 1成 |

### 1.5 市场情绪分类 —— `server/polars-engine.ts`

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

Phase 2: 五维评分计算（scoreStock()）
  ├─ K线趋势评分（40分）
  ├─ 价量配合评分（25分）
  ├─ 距60日低点评分（20分）
  ├─ 波动率-趋势适配评分（15分）
  └─ 相对强度评分（20分）
  → 原始满分 120 → 折算到 100 分制
  → 板块趋势 × 个股形态情境修正（默认规则 -10~+8，配置硬上限 -12~+10）
  → 限制到 0~100 → 返回 RankingRow
```

**核心引擎**：`scoreStock(series, date, sector?) → RankingRow | null`（`scoring-engine.ts`），同时被回测引擎和收盘决策使用。需要至少 20 根 K 线。

**总分标度**：五维原始满分 `RAW_SCORE_MAX = 120`，先统一折算到 `SCORE_SCALE = 100`，
再应用情境修正并限制在 0~100。
下游全是绝对阈值（入场线 40、策略分档 70/55/40/25/10），不折算的话加维度就会让这些阈值的含义整体漂移。

> **口径一致性**：`scoreStock`（实盘）与 `computeBacktestScores`（向量化回测）是同一套评分的两份实现，
> 历史上已经漂移过两次（向量化路径漏了 trendBonus 死区；实盘路径用个股 alignment 冒充板块趋势）。
> `tests/scoring-parity.test.ts` 逐股逐日比对五个维度、情境修正与最终总分，任何一处只改单边就会红。

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

判定按 **位置三分 × 涨跌幅五分** 的互斥网格展开，两组区间都穷尽且不重叠：

- 位置：`近高点`(距高点 > −5%) / `中位`(−15% ~ −5%) / `远离高点`(< −15%)
- 涨跌幅：`decline`(< −1%) / `flat`(−1% ~ 1%) / `smallGain`(1% ~ 3%) / `mildGain`(3% ~ 5%) / `bigGain`(> 5%)

| 量比 | 位置 | 涨跌幅 | 分值 | 标签 |
|------|------|--------|------|------|
| >1.5 | 近高点 | bigGain | 2 | 顶部放量 |
| >1.5 | 近高点 | flat | 1 | 高位滞涨 |
| >1.5 | 近高点 | decline | 2 | 放量下跌 |
| >1.5 | 近高点 | 其他 | 8 | 高位放量 |
| >1.5 | 远离高点 | mild/bigGain | 20 | 启动放量 |
| >1.5 | 远离高点 | smallGain | 18 | 低位启动 |
| >1.5 | 远离高点 | flat | 10 | 放量滞涨 |
| >1.5 | 远离高点 | decline | 2 | 放量下跌 |
| >1.5 | 中位 | bigGain | 12 | 追高放量 |
| >1.5 | 中位 | mildGain | 16 | 中位放量 |
| >1.5 | 中位 | smallGain | 15 | 中位放量 |
| >1.5 | 中位 | flat | 10 | 放量滞涨 |
| >1.5 | 中位 | decline | 2 | 放量下跌 |
| 1.1–1.5 | 近高点 | smallGain | 14 | 高位稳量 |
| 1.1–1.5 | 非近高点 | smallGain | 22 | 稳健放量 |
| 1.1–1.5 | — | mild/bigGain | 15 | 温和放量 |
| 1.1–1.5 | — | decline | 8 | 健康回调 |
| 1.1–1.5 | — | flat | 10 | 量价均衡 |
| <0.8 | — | 上涨 | 12 | 缩量上涨 |
| <0.8 | — | decline | 10 | 缩量下跌 |
| 其他 | — | — | 10 | 量价均衡 |

**量比计算**：近5日均量 / 再前5日均量

> 修复了两处结构缺陷：
> 1. **中位分支空洞** —— `启动放量` 要求距高点 < −15%、`追高放量` 只认涨幅 > 5%，
>    于是「放量 + 涨 4% + 距高点 −10%」谁都不命中，掉进兜底的「量价均衡」拿 10 分，标签和分值都是错的。现由 `中位放量` 承接。
> 2. **0% 附近的 16 分悬崖** —— 旧的 `decline(<0)` 与 `stagnation([-1,1])` 区间重叠且 decline 排在前面，
>    导致放量微跌 −0.5% 判「放量下跌」2 分、微涨 +0.5% 判「低位启动」18 分。现在滞涨区跨 0 对称，1 个百分点的日内噪音不再翻转结论。
>
> 边界仍是离散跳变（未做插值）：这套判定有实盘与向量化两份实现，
> 插值会让两边的对齐难度翻倍，而 parity 分歧正是本模块历史上最主要的 bug 来源。

#### 维度 3：距60日低点评分（20 分）

`distanceFromLowScore(distanceFromLowPct) → { score, label }`，写入 `position_score` / `position_label`，并计入 `total_score`。

| 距60日低点涨幅 | 分值 | 标签 |
|---------------|------|------|
| < 0% 或无效 | 2 | 贴近低点 |
| 0–5% | 4 | 贴近低点 |
| 5–15% | 10 | 刚离低点 |
| 15–30% | 18 | 启动确认 |
| 30–50% | 20 | 趋势上行 |
| 50–80% | 14 | 远离低点 |
| ≥ 80% | 8 | 高位延伸 |

#### 维度 4：波动率-趋势适配评分（15 分）

**波动率分类**（`volatilityClassOf()`）：从最近 20 个交易日的 `limit_up_record` 精确计数，`high`（≥3次） / `medium`（1-2次） / `low`（0次）。K 线涨跌幅不参与涨停识别。

**交叉评分矩阵**（`volatilityTrendScore()`）：

| 波动率 \ 板块趋势 | 上升 | 震荡 | 下跌 |
|:---:|:---:|:---:|:---:|
| **高** | 15 | 8 | 1 |
| **中** | 12 | 6 | 3 |
| **低** | 8 | 5 | 4 |

矩阵两个方向都单调，且两种单调性含义不同：

- **行**（同一波动率比趋势）：`up > range > down`。旧的 low 行是 `8 / 4 / 5`，
  「低波动 + 下跌」比「低波动 + 震荡」还高 1 分，是唯一一处行内倒挂。
- **列**（同一趋势比波动率）：下跌市里 `low > medium > high`（低波动受损最小），
  上涨/震荡市里 `high > medium > low`（高波动更有博弈价值）。这是刻意设计，不得"修正"。

> 板块趋势轴同时驱动维度 1 的板块加分（±4）与本维度的列选择。
> 拿不到板块状态时 `sector.trend` 必须为 `undefined`（板块加分为 0），
> **不得**回退到个股自身的均线排列 —— 那等于把同一个信号计入 2~3 次，且与向量化回测路径不一致。
> 本维度的 alignment 回退由 `scoreStock` 内部完成，两条路径口径相同。

#### 维度 5：相对强度（20 分）

`relativeStrengthScore(stockReturn, benchmarkReturn, config) → { score, label, excessPct }`

超额收益 = 个股 `lookback`(默认 20) 日收益 − 基准（上证指数 `sh000001`）同期收益，
线性映射到 0~20 分：`floorPct(-15)` 以下得 0，`capPct(+25)` 以上得满分。基准缺失时给中性分 10 并标注「基准缺失」。

| 超额收益 | 标签 |
|---------|------|
| ≥ +15pct | 显著跑赢 |
| ≥ +5pct | 跑赢大盘 |
| > −5pct | 同步大盘 |
| > −15pct | 跑输大盘 |
| 其余 | 显著跑输 |

补的是原本整套评分最大的缺口：README 的核心逻辑写着「指数定仓位」，
但此前四个维度全是绝对口径（距 60 日高/低点、均线排列、量比），没有任何一项衡量个股相对大盘的强弱 ——
牛市里所有股票的位置分一起上移、熊市一起下移，截面区分度被系统性压缩。

本维度刻意做成**连续**映射而非分档，不引入新的阈值悬崖。

### 2.3 板块趋势 × 个股形态情境修正

`sectorStrategyFeatures()` 只读取信号日及之前的数据，提取 1/3/5/10/20 日收益、
MA5/10/20、10 日上涨天数与波动率、当日量/前 20 日均量、距前 60 日高点、
以及 `block_top` 确认的前 60 日涨停次数。`sectorStrategyAdjustment()` 再按板块八态应用矩阵：

| 板块情境 | 个股形态 | 默认修正 | 标签 |
|---------|---------|---------:|------|
| state 6/7 下跌或暴跌 | MA5>MA10>MA20，20 日温和上涨、5 日不过热、10 日多数上涨且波动可控 | +8 | 穿越板块稳定上行 |
| state 6/7 下跌或暴跌 | 前 60 日有涨停事实，当前 5/10 日多日超跌或放量恐慌日 | +8 | 前强股恐慌极点 |
| state 6/7 下跌或暴跌 | 无前强证据但进入恐慌极点 | +5 | 恐慌极点 |
| state 6/7 下跌或暴跌 | 单日 ≥6%、3 日 ≥12% 或 5 日 ≥16%，且仍远离前高 | -10 | 下跌市暴力反弹 |
| state 6/7 下跌或暴跌 | 5 日反弹 ≥2%，但没有稳定独立结构 | -4 | 普通逆势反弹 |
| state 1/2 强势或高位 | 当日量比 ≥1.5 且收盘创前 60 日新高 | -10 | 强势行情放量新高 |
| state 8 筑底成功 | 当日量比 ≥1.5 且收盘创前 60 日新高 | +8 | 筑底放量新高 |
| state 1/3 上升/首次回调 | 稳定顺势，且没有放量追高信号 | +2 | 顺势稳定上行 |

**风险减分优先**由分支结构保证：追高、暴力反弹或普通逆势一旦命中就直接返回，
机会加分强制为 0，不能用“恐慌极点”或“稳定趋势”抵消风险。输出字段包括
`sector_strategy_score`、`sector_risk_penalty`、`sector_opportunity_bonus`、
`sector_strategy_label`、`sector_strategy_reason`。

情境分不是第六个基础因子，不进入五维权重归一化；它在加权后的 100 分制基础分上原值应用，
避免风险扣分被某组因子权重稀释。

### 2.4 总分与策略判定

`strategyForScore(score) → { strategy_action, strategy_label, strategy_position }`

| 总分区间 | 策略动作 | 标签 | 仓位系数 |
|---------|---------|------|---------|
| ≥ 70 | accumulate | 重点加仓 | 0.8 |
| ≥ 55 | accumulate | 趋势跟踪 | 0.6 |
| ≥ 40 | trade | 短线博弈 | 0.4 |
| ≥ 25 | trade | 轻仓试探 | 0.2 |
| ≥ 10 | reduce | 观望减仓 | 0.05 |
| < 10 | ignore | 坚决回避 | 0 |

五维原始满分 120 ＝ 趋势40 + 价量25 + 距60日低点20 + 波动15 + 相对强度20。
最终总分公式：`clamp(五维原始分 × 100 / 120 + sector_strategy_score, 0, 100)`。

**这张表现在真的生效了**：`calculateEntrySize` 会按 `positionRatioForScore(totalScore)` 缩放单票额度
（`T1StrategyConfig.scoreScaledSizing`，默认开启），高分股票拿更大仓位。
在此之前 `positionRatioForScore` / `strategyForScore` 只被测试引用，实盘与回测一律用固定的 `positionSizePct`，
**所有入选股票仓位完全相同**，评分只决定「买不买」而不决定「买多少」—— 文档描述的行为从未运行过。

模拟交易的指令会记录 `signal_score`，执行时用计划时的同一个总分重算仓位，避免计划量与成交量不一致。

**排序并列**：四个离散维度让 `total_score` 的取值集合很小、并列极多。
`compareByScore` 用连续量 `trend_strength` 作次键破平局，`stock_code` 只作最终兜底 ——
旧实现直接用 `stock_code.localeCompare`，导致 top-N 选股系统性偏向代码小的股票（000xxx / 600xxx）。

---

## 3. 回测 —— `server/backtest-engine.ts`（驱动）+ `server/backtest-scoring.ts`（向量化评分）

### 3.1 数据采集

**入口**：`collectHistoricalMarketData(rankings, options) → HistoricalMarketData | null`

**流程**：

```
1. 并发采集历史日线（Semaphore 12 → 24）
   ├─ 获取交易日历（基于节假日数据反推，holiday-calendar.ts）
   └─ 并发拉取每只股票「回测天数 + 70」天真实日线（多源降级链路）
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
   ├─ 对每个板块在每个回测日期调用 analyzeBlockTrend()（日线 + 周月交叉验证）
   └─ 窗口长度取 SECTOR_STATE_WINDOW_BARS / HIGHER_TIMEFRAME_WINDOW_BARS，与实盘路径严格一致
   → 返回 Map<sector_code, Map<date, state_id>>

2. 构建扁平化列数组
   ├─ 展开所有股票的所有 K 线为列数组（stock_code, date, open, close, ...）
   ├─ computeStockArrays() 计算 trend_strength（滚动线性回归斜率/均价）和涨停标记
   └─ 通过 sector_history 查找每个日期最近的前 past block_top 记录确定板块归属

3. 单次 Polars DataFrame 运算
   ├─ 滚动窗口：MA5/10/20/60、量比、60日高点、20日涨停计数
   ├─ 均线排列分类（bullish/bearish/tangled）
   ├─ 五维评分：趋势(40) + 价量(25) + 位置(20) + 波动率(15) + 相对强度(20) → 折算 100 分制
   ├─ 共享 sectorStrategyFeatures/Adjustment 计算板块情境修正
   ├─ 基础分 + 情境修正 → 限制到 0~100
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

**因子加权**（`FactorWeights`，`backtest-engine.ts`）：`applyFactorWeights()` 对五个维度施加线性权重。
可在 `POST /api/backtest/run` 通过 `trend_weight_pct / volume_price_weight_pct / distance_from_low_weight_pct /
volatility_weight_pct / relative_strength_weight_pct` 覆盖，**范围 1–200**（100 为中性），默认均为 100：

| 权重字段 | 默认 | 作用维度 |
|----------|------|----------|
| `trendWeightPct` | 100 | 维度 1：K 线趋势评分 |
| `volumePriceWeightPct` | 100 | 维度 2：价量配合评分 |
| `distanceFromLowWeightPct` | 100 | 维度 3：距 60 日低点评分 |
| `volatilityTrendWeightPct` | 100 | 维度 4：波动率-趋势适配评分 |
| `relativeStrengthWeightPct` | 100 | 维度 5：相对强度评分 |

> **权重是归一化的**：加权和会除以「本组权重下的理论满分」再放大回 100 分制，
> 所以调权重只改变维度的**相对**影响，不改变总分量纲。全 100 时结果与未加权的 `scoreStock` 完全一致。
> `sector_strategy_score` 在归一化完成后原值应用，不参与五维权重；风险扣分不会因调低某个因子权重而失效。
>
> 这一点是必须的。下游全是绝对阈值（入场线 `minEntryScore=40`、策略分档 70/55/40/25/10）。
> 旧写法直接乘 `pct/100` 且上限锁在 100 —— 权重只能往下调，总分就只会缩水：
> 例如 `(trend 70, distance 70)` 把理论满分压到 82，40 分的入场线等效变成原口径的 **48.8 分**。
> 于是参数优化器搜索权重时，同时改变了「因子相对权重」与「绝对入场松紧」两件事，
> 两个效应完全纠缠，搜出来的"最优权重"很可能只是在调仓位数量，而不是在调因子。
> 上限放宽到 200 后，权重可以「加强」而不只是「削弱」某个维度。

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

### 3.4 参数优化 —— `server/backtest-param-optimizer.ts`

> 两阶段：以「完整回测收益」为最终目标，而不是截面相关性。若优化结果跑不过默认基线，则回退到默认参数。

**核心接口**：`optimizeStrategyParams(history, { days? }) → ParamOptimizeResult`

**输入**：与 `runPolarsBacktest` 相同的 `HistoricalMarketData`（可在 `/api/backtest/optimize` 接口传 `days`，默认 20，区间 5–750）。回测窗口长度与 MA60 等评分指标独立，指标预热由 `HISTORICAL_WARMUP_DAYS`（70 日）保证。

**输出结构**（同时回传给前端 + 持久化到任务结果）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `days` | int | 实际使用的回测窗口 |
| `scoring.config` | `ScoreStockConfig` | 阶段1 选出的完整评分配置 |
| `scoring.scoreCorrelation` | number | 距60日低点评分与 5 日远期收益的相关系数 |
| `scoring.topBottomSpreadPct` | number | 评分前 20% 与后 20% 的 5 日远期差（≥0 越理想） |
| `scoring.distanceBucketStats[]` | array | 每个分档的样本数、位置分、5 日远期收益均值、胜率 |
| `scoring.sweetSpotLabels` | string[] | 远期为正、样本≥5 的两个最佳分档（如「启动确认、趋势上行」） |
| `optimized` | object | 阶段2 选出的回测交易参数（`maxHoldDays/maxPositions/positionSizePct/takeProfitPct/stopLossPct`） + 因子权重 |
| `validation` | object | 阶段2 网格在最优参数上的回测验证：`totalReturnPct/winRate/maxDrawdownPct/totalTrades` |
| `baseline` | object | 默认 scoreStock + 默认策略参数的基线结果，用来对比 |
| `beatBaseline` | bool | 阶段2 是否超越基线；为 `false` 时回退默认 |
| `methodology` | string | 一段中文说明使用的搜索空间、最终目标和比较基准 |

**阶段 1：scoreStock 评分参数搜索**

```
1. collectRawObservations() 用默认评分 + 默认策略参数构建 BacktestContext
   └─ 对每个回测交易日 × 股票，取 observation =
        { distancePct, alignment, trendStrength, volumePriceScore,
          limitUpCount20d, sectorTrend, forwardByHold[5 日] }
2. scoreConfigCandidates() 网格：
   ├─ 阈值网格 3 组（5/15/30/50/80、5/12/25/45/75、5/18/35/55/85）
   ├─ 趋势网格 3 组（multiplier=300/400/500，bullish=24/28/32）
   └─ 共 3×3=9 组 + 默认 1 组 = 10 个候选 ScoreStockConfig
3. 每个候选：
   ├─ buildDistanceConfigFromStats() 用样本均值+胜率重赋 tier.score
   ├─ prepareBacktestContext(history, days, config) 重新计算评分矩阵
   ├─ quickSimulateBacktest(context, defaultParams) 跑一次完整回测
   └─ backtestObjective() = 收益 − 0.45×回撤 + (胜率≥50 ? 1 : 0)
                                − max(0, (35−胜率)×0.08)
                                − 交易<6 罚 12 / 交易<8 罚 4
4. 优先保留交易数 ≥ 6 的可靠样本，再按 `totalReturnPct` 选最高收益；收益率相同时才用 objective 作为风险 tie-breaker
   → 关联该次回测得到的 actualValidation
```

**阶段 2：回测交易参数网格**

固定 `scoring.config`，在同一 `BacktestContext`（避免重算评分矩阵）上做两层网格：

```
2a 核心交易参数：6 持仓天数 × 5 止盈 × 5 止损 = 150 组
2b 仓位（在 2a 最优基础上）：4 持仓个数 × 4 单票仓位 = 16 组
2c 五个因子权重坐标下降：2 轮 × 5 维 × 3 取值 = 30 组
合计约 187 组回测（含种子方案；跳过与当前值相同的权重）→ 先排除交易样本不足的方案，再选收益率最高；收益相同时才选 objective 更优
```

> **2c 的三处修正**：
> 1. 旧版只搜 `trend` / `distanceFromLow` 两维，`volumePrice` / `volatility` / `relativeStrength` 恒为 100，从未被优化。
> 2. `volatilityWeightPct` 即使传了也**被静默丢弃** —— 优化器用的字段名与 `quickSimulateBacktest` 读的
>    `volatilityTrendWeightPct` 不匹配。现在两个名字都接受。
> 3. 取值区间从 `[70, 100]`（只能往下调）改为以 100 为中心的 `70 / 100 / 130`。
>
> 全网格是 3⁵ = 243 组；坐标下降只要 30 组，覆盖的维度反而更多。

若阶段 2 的 `totalReturnPct` 仍未严格超过阶段 0 的默认基线（默认 scoreStock + 默认策略参数跑出的 `baseline.validation`），将 `optimized/validation/scoring.config` 一并回退为默认，并在 `methodology` 中说明「未超越默认方案」。风险调整 objective 不再允许覆盖这个收益率门槛。

**复用工具** —— `server/backtest-engine.ts`：

| 函数 | 作用 |
|------|------|
| `prepareBacktestContext(history, days, scoringConfig?)` | 构建可复用上下文（评分矩阵 + 日历 + Map） |
| `quickSimulateBacktest(context, options) → { totalReturnPct, winRate, maxDrawdownPct, totalTrades }` | 在已有 context 上快速跑一次回测，参数覆盖默认值 |

**API**（`server/app/routes.ts`）：

```
POST /api/backtest/optimize?days=20&date=YYYYMMDD
  → 202 { task_id, status: 'started', message: '参数优化任务已启动' }
  → 任务进度：
     ├─ 0–55% ：marketService.ensureHistoricalCoverage()（必要时补采行情）
     ├─ 58%   ：「阶段1：优化 scoreStock 评分参数」
     └─ 90%   ：「阶段2：网格搜索回测交易参数」
  → 完成后从 GET /api/tasks/:taskId.result 读取：
     ├─ scoring.{config, scoreCorrelation, topBottomSpreadPct,
     │           distanceBucketStats[], sweetSpotLabels[]}
     ├─ optimized: { maxHoldDays, maxPositions, positionSizePct,
     │               takeProfitPct, stopLossPct, trendWeightPct, ... }
     ├─ validation:  { totalReturnPct, winRate, maxDrawdownPct, totalTrades }
     ├─ baseline/beatBaseline/methodology
     └─ 也可在 WebSocket `/ws/tasks` 收到 `type=task_progress` 实时进度
```

**前端展示**（`src/pages/BacktestPage.tsx`）：

- 「回测设置」modal 顶部新增「参数优化」面板，显示 `scoreCorrelation` + `validation` 摘要
- 「开始参数优化」→ 调起异步任务，完成后弹出「参数优化结果」modal（含阶段 1 评分配置表 + 阶段 2 交易参数 + 验证 vs 基线对比 + 分档收益明细 + ★ 优选分档）
- 「应用到回测设置」一键把推荐参数写回回测表单
- 历史记录 modal：支持分页（`HISTORY_PAGE_SIZE = 15`）+ 勾选批量删除

---

## 3.5 因子有效性评估 —— `server/factor-ic.ts`

> 与回测收益**正交**的证据链。参数优化在几十个交易日上找「收益最高的权重」极易过拟合 ——
> 它优化的是这段样本的路径，而不是因子的预测能力。这里回答的是另一个问题：
> **某个维度到底有没有预测未来收益？**

**接口**：`computeFactorIC(history, days=60, forwardDays=5, scoringConfig?) → FactorICReport`

**API**：`GET /api/backtest/factor-ic?days=60&forward_days=5`

**输出指标**（逐维度 + 总分）：

| 指标 | 含义 | 判读 |
|------|------|------|
| `meanIC` | 逐日截面 RankIC（因子值排名 vs 未来收益排名的 Spearman）的时序均值 | \|IC\| > 0.03 有效，> 0.05 强 |
| `stdIC` | RankIC 的时序标准差 | — |
| `icir` | `meanIC / stdIC`，稳定性 | IC 高但忽正忽负的因子不可用 |
| `tStat` | `icir × sqrt(天数)` | \|t\| > 2 才算显著 |
| `positiveRatio` | IC > 0 的交易日占比 | 接近 50% 说明是噪音 |
| `quintileReturns[5]` | 按因子值五等分后各档的未来平均收益 | — |
| `monotone` | 分层收益是否随因子值单调上升 | `false` 说明关系非线性或纯噪音 |

**因子相关矩阵**：`correlations[]` 给出五个维度两两的截面 Spearman 相关（`total_score` 是线性组合，不参与）。
相关性 > 0.7 提示两个维度在重复计入同一个信号 —— 例如板块趋势同时驱动维度 1 的板块加分与维度 4 的趋势轴选择。

**口径说明**：未来收益取「信号日收盘 → `forwardDays` 个交易日后收盘」。
回测实际是次日开盘成交，两者有 1 日错位；IC 衡量的是因子的**排序能力**而非可实现收益，收盘对收盘是标准做法。

**建议用法**：调权重前先看 IC。一个 `meanIC ≈ 0`、`monotone=false` 的维度，
无论参数优化把它的权重调到多少，都只是在拟合噪音。

---

## 4. 交易计划生成 —— `server/paper-trading.ts`

### 4.1 策略上下文构建 —— `loadPaperContext()`（`server/app.ts`）

**数据来源**：

| 数据 | 来源 | 用途 |
|------|------|------|
| 缓存分析结果 | `server/data/runtime/analysis.json` | 指数仓位建议 |
| 排行榜 | `server/data/trending.db`：`ranking_factor` + `stock_ranking` | 选股标的；`runtime/ranking.json` 仅作最新缓存 |
| 排行配置 | `server/data/runtime/ranking-config.json` | 因子权重 + 评分配置（可从回测优化回填） |
| 市场情绪 | `analysis.json` 中的 sentiment | 买卖门控 |
| 历史行情快照 | `server/data/trending.db`：`stock_daily_price` + `index_daily_price` + `historical_snapshot` | 收盘决策时重排行（`historicalStrategyCandidates()`） |

**排行配置来源链**（`MarketService.computeAndSaveRanking()`）：

```
POST /api/ranking/compute 显式传入 rankingConfig
  │
  ├─ 有 → 使用传入配置
  └─ 无 → 读取 data/runtime/ranking-config.json
           │
           ├─ 有 → 使用已保存配置（含因子权重 + 评分配置 + 回测来源 run_id）
           └─ 无 → defaultRankingRuntimeConfig()（默认权重 + 默认评分配置）
```

`POST /api/simulated-trading/strategy/apply-backtest` 会同时：
1. 调用 `paper.applyBacktestStrategy()` 将回测交易参数写入模拟交易策略
2. 调用 `rankingConfigFromBacktest()` 提取因子权重 + 评分配置 → `saveRankingConfig()`
3. 若股票池非空，调用 `computeAndSaveRanking()` 按新配置重算截面排行

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

**市场强弱判断**（`assessMarketTiming()`，`server/paper-trading/helpers.ts`）：

```
指数口径（默认生效，1–8 视为有效）：
  - risk_indices    = state_id ∈ {6,7} 的指数数
  - bullish_indices = state_id ∈ {1,2,3,8} 的指数数
  - risk_threshold  = ceil(valid_indices × 0.3)

有 marketAverageChange 时：
  - 弱市 ← 上一交易日全市场平均涨幅 ≤ 0

无 marketAverageChange 时：
  - 弱市 ← 任一满足：
       1. sentiment = cold
       2. broadRiskIndices（宽基代码: sh000001/sz399001/sz399006/
          sh000300/sh000905/sh000016/sh000688 中出现 6/7）> 0
       3. valid_indices>0 && risk_indices ≥ risk_threshold
                          && risk_indices ≥ bullish_indices
  - 否则为强市，defaultReason 写入 overview.plan.market_reason

强市 → 买入开盘执行、卖出临近收盘执行
弱市 → 买入临近收盘执行、卖出开盘执行
```

> `state_id=8`（筑底成功）被算作偏强指数；`state_id=0`（数据不足）会从有效统计中剔除。

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

> 上述默认值来自 `trading-strategy.ts` 的 `DEFAULT_T1_STRATEGY = Object.freeze(...)`。
> `paper-trading.ts` 默认在 `maxEntriesPerDay` / `maxCandidates` 不显式传入时，会自动把"日新增上限"提到 `maxEntriesPerDay ≥ maxPositions`，"候选上限"提到 `max(maxCandidates, maxPositions*3)`，以保证实盘计划能补足目标仓位。

**辅助函数**（`trading-strategy.ts`）：
- `rankEntryCandidates(rows, excludedCodes, limit)` — 过滤 `accumulate`/`trade` 策略，按总分排序取前 N
- `calculateEntrySize(cash, referenceCapital, price, config)` — 计算仓位股数（含佣金）
- `exitSignalReason(pnlPct, holdDays, config)` — 止损/止盈/到期判断
- `tradingDayDistance(fromDate, toDate, calendar)` — 交易日天数（含交易日历和周末回退）

---

## 5. 自动化调度 —— `server/paper-trading.ts`

### 5.1 窗口定义

| 窗口 | 可重试时段 | 操作 |
|------|------|------|
| **开盘窗口** | 9:31 - 10:00 | 执行卖单（止损/止盈/到期） + 买单（市场强时） |
| **临收盘窗口** | 14:57 - 15:00 | 执行买单（市场弱时） |
| **收盘决策** | 15:05 - 23:30 | 采集当日排行生成次日交易计划 |
| **盘后核对** | 15:10 - 23:30 | 状态核对 |

开盘/临收盘窗口的时段就是**成交时段**，错过即作废，不做盘中补执行 ——
`executePlannedOrders` 按 `execution_window` 精确匹配，开盘计划不会在临收盘被顺带打出去。

收盘决策/盘后核对只读本地排行并回写次日计划，不涉及成交价，所以重试时段拉到
`LATE_WINDOW_END_MINUTE`（23:30）：同花顺晚间才恢复也能补生成次日计划，
否则 15:05-15:20 内全失败就意味着次日无计划可执行。

### 5.2 调度循环

```
每 15 秒轮询一次
  │
  ├─ 过期清算 expireStalePlans()          ← 先于所有闸门
  │     └─ 只按"执行日是否已过"判定，不读同花顺、不看交易日、不看自动化开关
  │        无到期项则直接返回，不落盘
  │
  ├─ 自动化未启用 / 今日暂停 → 结束
  ├─ 非交易日 → 结束
  │
  ├─ 同花顺预热 warmUpThs()               ← 先于 due 计算
  │     └─ 09:25-09:31 / 14:50-14:57 / 15:03-15:05 各一次
  │        把 open -a + 登录 + 切模拟 tab 挪到成交窗口之外
  │
  ├─ 判断当前属于哪个窗口
  ├─ 检查该窗口是否已触发（completed_windows 记录）
  │
  ├─ 开盘窗口 (9:31 - 10:00):
  │     ├─ 读取账户 → 执行卖出信号
  │     └─ 如果市场强 → 执行买入信号
  │
  ├─ 临收盘窗口 (14:57 - 15:00):
  │     └─ 如果市场弱 → 执行买入信号
  │
  ├─ 收盘决策 (15:05 - 23:30):
  │     └─ 生成下个交易日信号（卖出+买入）
  │
  └─ 盘后核对 (15:10 - 23:30):
        └─ 核对持仓

  非窗口时段:
    每 60 秒执行一次账户监控
    （仅交易时段 9:25-15:20）
  │
  └─ 任意窗口失败 → last_error 写回 state，并按窗口独立指数退避重试
        windowRetryDelayMs：20s → 40s → 80s → …
        开盘/临收盘封顶 2 分钟（窗口短，要压满重试次数）
        收盘/盘后封顶 15 分钟（可跑整晚，退避拉开以免反复弹同花顺窗口）
        退避状态按 `${交易日}:${窗口}` 分桶，窗口之间互不拖累
```

**过期清算为什么必须独立**：清算曾挂在 `monitorAccount` 上，而后者要走 AppleScript
读同花顺账户。叠加"非交易日直接 return""监控时段限 9:25-15:20""15:05-15:20 被
窗口执行抢占"三重门槛后，有效清算窗口只剩 **15:00-15:05 且同花顺必须在线**；
同花顺那 5 分钟不在线，计划就一直停在"待执行"。现在清算是纯日历+时钟判定，
服务一启动的首个 tick 就会把隔夜陈旧计划清掉。

### 5.3 同花顺就绪 —— `server/ths-lifecycle.ts`

窗口失败的头号原因不是策略，是**同花顺没在跑**：7-30、7-31 的开盘窗口全部失败于
`同花顺尚未运行 (-2700)` 或 `同花顺进程在运行但读不到任何窗口(count=0)`。

```
ThsLifecycle.ensureReady(reason, { timeoutMs })
  │
  ├─ probe                     ← osascript，约 300ms，只读不点界面
  │     running=true & windows>0 → 直接返回 ready，绝大多数调用走这条
  │
  ├─ 取文件锁 <runtime>/ths-lifecycle.lock
  │     拿不到 → 别的进程正在拉起，只回报探测结果，不重复点界面
  │     锁超 5 分钟或持有者 pid 已消失 → 夺锁
  │
  ├─ 锁内复探（排队期间对方可能已拉好）
  ├─ 进程不在 → open -a 同花顺，轮询等进程出现（≤30s）
  ├─ launch-flow                ← 点登录 → 切交易页 → 切模拟 tab
  └─ 复探确认 → { ready, launched, probe, message }
```

**判据是窗口数不是进程**：进程活着但 `windows=0`（最小化到 Dock、在其它 Space、
屏幕锁定）时下单脚本一样读不到界面，所以 `ready = running && windows > 0`。

接入点：

| 时机 | 预算 | 位置 |
|---|---|---|
| 预热 09:25 / 14:50 / 15:03 | 120s / 120s / 90s | `tickScheduler`，due 计算之前 |
| 窗口内兜底 | 开盘·收盘·盘后 120s，**临收盘 45s** | `runWindow`，`validateWindowTime` 之后、读账户之前 |
| 账户监控 | 不接 | 避免用户手动关掉后被反复拉起 |

兜底位置在**任何下单之前**，所以不存在"下单失败后重拉重试导致重复报单"的风险。
拉不起来也不抛错：让窗口自己去撞券商调用并走既有失败退避，失败原因保持券商原始报错。

`scripts/ths-lifecycle.mjs` 守护进程复用同一个 `ThsLifecycle` 和同一把锁，
只保留"何时动手"的策略（09:00-09:25 预拉起、收盘后退出）。两边同时跑
`launch-flow` 会同时点同一个界面，锁就是为此而设。

### 5.4 自动化状态持久化

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
  "asset_history": [],
  "last_signal_date": "20260722",
  "updated_at": "2026-07-23 09:31:05"
}
```

- `enabled=false` 为默认安全状态，需前端手动启用
- `completed_windows` 记录已触发窗口，防重启重复触发
- `paused_today` 暂停当天剩余窗口
- 服务重启时，`submitting` 状态的指令自动标记为 `uncertain`，需人工核对
