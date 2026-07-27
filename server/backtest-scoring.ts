import pl from 'nodejs-polars';
import type { RankingRow } from '../src/types.js';
import { round } from './format.js';
import type { HistoricalBlockSeries, HistoricalMarketData } from './historical-market.js';
import { analyzeBlockTrend, compareByScore, type MarketStateThresholds, HIGHER_TIMEFRAME_WINDOW_BARS, MIN_HIGHER_TIMEFRAME_BARS, RAW_SCORE_MAX, SCORE_SCALE, SECTOR_STATE_WINDOW_BARS, volatilityTrendScore, type Bar, type ScoreStockConfig, type TrendAxis, type VolatilityClass, DEFAULT_SCORE_STOCK_CONFIG } from './scoring-engine.js';

// ---------------------------------------------------------------------------
// Vectorized backtest scoring: computes the full (stock × date) score matrix
// in a single Polars pass, replacing the per-day per-stock scoreStock loop.
// ---------------------------------------------------------------------------

/** Pre-compute trend_strength and limit_up flag per stock in one O(n) pass. */
function computeStockArrays(
  closes: Float64Array,
  dates: string[],
  limitUpDates: ReadonlySet<string> | undefined,
): { strength: Float64Array; limitUp: Float64Array } {
  const n = closes.length;
  const strength = new Float64Array(n);
  const limitUp = new Float64Array(n);
  const lookback = 20;
  const sumX = (lookback - 1) * lookback / 2;
  const sumX2 = (lookback - 1) * lookback * (2 * lookback - 1) / 6;

  for (let i = 0; i < n; i += 1) {
    // Limit-up flag
    if (limitUpDates?.has(dates[i])) limitUp[i] = 1;
    // Trend strength (rolling linear regression slope / mean)
    const start = Math.max(0, i - lookback + 1);
    const len = i - start + 1;
    if (len < 5) continue;
    let sy = 0;
    let sxy = 0;
    for (let j = start; j <= i; j += 1) {
      const x = j - start;
      sy += closes[j];
      sxy += x * closes[j];
    }
    const denom = len * sumX2 - sumX * sumX;
    if (!denom) continue;
    // For partial windows (len < 20), sumX/sumX2 differ from the full-window constants
    const actualSumX = (len - 1) * len / 2;
    const actualSumX2 = (len - 1) * len * (2 * len - 1) / 6;
    const actualDenom = len * actualSumX2 - actualSumX * actualSumX;
    if (!actualDenom) continue;
    const slope = (len * sxy - actualSumX * sy) / actualDenom;
    const mean = sy / len;
    strength[i] = mean > 0 ? slope / mean : 0;
  }
  return { strength, limitUp };
}

/**
 * Pre-compute rolling sector trend states for each date in the backtest range.
 * Returns Map<sector_code, Map<date, state_id>>.
 *
 * 与首页 Live 路径一致：使用 analyzeBlockTrend（日 + 周月交叉验证）。
 * classifyMarketState 最多用 60 根日线；周月线在窗口范围内按"截止日 <= 当前回测日"过滤。
 */
function computeSectorStates(
  blocks: HistoricalBlockSeries[],
  dates: string[],
  thresholds: MarketStateThresholds,
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const block of blocks) {
    const bars: Bar[] = block.bars.map((b) => ({
      date: String(b[0]),
      open: b[1],
      close: b[2],
      high: b[3],
      low: b[4],
      volume: b[5],
      amount: b[6],
      changePct: b[7],
    }));
    const weeklyBars: Bar[] | undefined = block.weekly_bars?.map((b) => ({
      date: String(b[0]),
      open: b[1],
      close: b[2],
      high: b[3],
      low: b[4],
      volume: b[5],
      amount: b[6],
      changePct: b[7],
    }));
    const monthlyBars: Bar[] | undefined = block.monthly_bars?.map((b) => ({
      date: String(b[0]),
      open: b[1],
      close: b[2],
      high: b[3],
      low: b[4],
      volume: b[5],
      amount: b[6],
      changePct: b[7],
    }));
    // Build date → index lookup（compact 8 位）
    const indexByDate = new Map<string, number>();
    for (let i = 0; i < bars.length; i += 1) {
      const d = bars[i].date.replaceAll('-', '').slice(0, 8);
      indexByDate.set(d, i);
    }
    const stateMap = new Map<string, number>();
    for (const date of dates) {
      const endIdx = indexByDate.get(date);
      if (endIdx == null || endIdx < 19) continue;
      // 与实盘 computeSectorTrendFromBlockPrices 取同一窗口长度，否则 ADX 的
      // Wilder 平滑（路径依赖）会让两条路径在同一日给出不同 state_id。
      const window = bars.slice(Math.max(0, endIdx - SECTOR_STATE_WINDOW_BARS + 1), endIdx + 1);
      // 周/月线按截止日过滤后同样截断到共享窗口，保证与实盘路径口径一致。
      const filterUpTo = (target: string, source: Bar[] | undefined): Bar[] | undefined => {
        if (!source?.length) return undefined;
        const filtered = source.filter((b) => b.date.replaceAll('-', '').slice(0, 8) <= target);
        return filtered.length >= MIN_HIGHER_TIMEFRAME_BARS
          ? filtered.slice(-HIGHER_TIMEFRAME_WINDOW_BARS)
          : undefined;
      };
      const weeklyWindow = filterUpTo(date, weeklyBars);
      const monthlyWindow = filterUpTo(date, monthlyBars);
      const state = analyzeBlockTrend(window, weeklyWindow, monthlyWindow, thresholds);
      if (state.state_id >= 1 && state.state_id <= 8) {
        stateMap.set(date, state.state_id);
      }
    }
    if (stateMap.size) result.set(block.block_code, stateMap);
  }
  return result;
}

/** 基准指数代码：与实盘 MarketService 取同一条曲线（上证指数）。 */
export const BENCHMARK_SYMBOL = 'sh000001';

/**
 * 基准指数在 lookback 窗口上的收益率(%)，按 compact 日期查表。
 * 找不到指数序列时返回空表 —— 维度 5 会退回中性分而不是把所有股票一起打低。
 */
export function benchmarkReturns(
  history: HistoricalMarketData,
  lookback: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const index = history.indices?.find((item) => item.symbol === BENCHMARK_SYMBOL) ?? history.indices?.[0];
  if (!index?.bars?.length) return result;
  const bars = [...index.bars].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (let i = lookback; i < bars.length; i += 1) {
    const base = Number(bars[i - lookback][2]);
    const close = Number(bars[i][2]);
    if (!(base > 0)) continue;
    result.set(String(bars[i][0]).replaceAll('-', '').slice(0, 8), (close - base) / base * 100);
  }
  return result;
}

/**
 * Compute the full score matrix for all stocks × dates in one vectorized pass.
 * Returns a Map keyed by date, each value is the ranked list of scoring rows.
 */
export function computeBacktestScores(
  history: HistoricalMarketData,
  dates: string[],
  limitUpDatesByCode: Map<string, Set<string>>,
  scoringConfig: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): Map<string, RankingRow[]> {
  const dateSet = new Set(dates);
  const { distanceFromLow, trend, volatilityTrend, relativeStrength } = scoringConfig;
  const distanceTiers = [...distanceFromLow.tiers].sort((left, right) => left.maxPct - right.maxPct);

  // ---- 0. Pre-compute rolling sector trend states ----
  const sectorStateByDate = computeSectorStates(history.blocks ?? [], dates, scoringConfig.marketState);
  // 基准（上证指数）在 relativeStrength.lookback 窗口上的收益率，按日期查表。
  // 与实盘 scoreStock 用同一个基准，否则维度 5 会成为新的回测/实盘分歧来源。
  const benchmarkReturnByDate = benchmarkReturns(history, relativeStrength.lookback);
  // Build per-stock sector history (sorted by date) for forward-looking assignment.
  // For each stock on each date, use the most recent past block_top record's sector.
  const stockSectorHistory = new Map<string, Array<{ date: string; sector: string }>>();
  for (const record of history.limit_up_records ?? []) {
    if (!record.sector_code || !/^\d{6}$/.test(record.sector_code)) continue;
    const list = stockSectorHistory.get(record.stock_code) ?? [];
    list.push({ date: record.date, sector: record.sector_code });
    stockSectorHistory.set(record.stock_code, list);
  }
  for (const list of stockSectorHistory.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---- 1. Flatten all bars into column arrays ----
  const stockCodes: string[] = [];
  const stockNames: string[] = [];
  const barDates: string[] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const volumes: number[] = [];
  const amounts: number[] = [];
  const changePcts: number[] = [];
  const trendStrengths: number[] = [];
  const limitUpFlags: number[] = [];
  const sectorStateIds: number[] = [];
  const benchmarkReturnPcts: number[] = [];
  const benchmarkKnownFlags: number[] = [];

  for (const stock of history.stocks) {
    const bars = [...stock.bars].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const n = bars.length;
    const closeArr = new Float64Array(n);
    const dateArr: string[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      closeArr[i] = Number(bars[i][2]);
      dateArr[i] = String(bars[i][0]).replaceAll('-', '').slice(0, 8);
    }
    const { strength, limitUp } = computeStockArrays(
      closeArr,
      dateArr,
      limitUpDatesByCode.get(stock.stock_code),
    );
    // Sector state for this stock on each date: walk forward through sector history
    // to find the most recent block_top record on or before the current bar date.
    const sectorHistory = stockSectorHistory.get(stock.stock_code);
    let sectorCursor = 0;
    let currentSector: string | undefined;
    for (let i = 0; i < n; i += 1) {
      stockCodes.push(stock.stock_code);
      stockNames.push(stock.stock_name);
      barDates.push(dateArr[i]);
      opens.push(Number(bars[i][1]));
      closes.push(closeArr[i]);
      highs.push(Number(bars[i][3]));
      lows.push(Number(bars[i][4]));
      volumes.push(Number(bars[i][5]));
      amounts.push(Number(bars[i][6]));
      changePcts.push(Number(bars[i][7]));
      trendStrengths.push(strength[i]);
      limitUpFlags.push(limitUp[i]);
      // Advance cursor while records are on or before the current bar date
      while (sectorHistory && sectorCursor < sectorHistory.length && sectorHistory[sectorCursor].date <= dateArr[i]) {
        currentSector = sectorHistory[sectorCursor].sector;
        sectorCursor += 1;
      }
      const stateMap = currentSector ? sectorStateByDate.get(currentSector) : undefined;
      sectorStateIds.push(stateMap?.get(dateArr[i]) ?? 0);
      const benchmark = benchmarkReturnByDate.get(dateArr[i]);
      benchmarkReturnPcts.push(benchmark ?? 0);
      benchmarkKnownFlags.push(benchmark == null ? 0 : 1);
    }
  }

  if (!stockCodes.length) return new Map();

  // ---- 2. Build DataFrame ----
  let frame = pl.DataFrame({
    stock_code: stockCodes,
    stock_name: stockNames,
    date: barDates,
    open: opens,
    close: closes,
    high: highs,
    low: lows,
    volume: volumes,
    amount: amounts,
    change_pct: changePcts,
    trend_strength: trendStrengths,
    limit_up_flag: limitUpFlags,
    sector_state_id: sectorStateIds,
    benchmark_return_pct: benchmarkReturnPcts,
    benchmark_known: benchmarkKnownFlags,
  }).sort(['stock_code', 'date']);

  // ---- 3. Rolling features (per stock) ----
  const g = 'stock_code';
  frame = frame.withColumns(
    pl.col('close').rollingMean({ windowSize: 5 }).over(g).alias('ma5'),
    pl.col('close').rollingMean({ windowSize: 10 }).over(g).alias('ma10'),
    pl.col('close').rollingMean({ windowSize: 20 }).over(g).alias('ma20'),
    pl.col('close').rollingMean({ windowSize: 60 }).over(g).alias('ma60'),
    pl.col('volume').rollingMean({ windowSize: 5 }).over(g).alias('vol_recent_5'),
    pl.col('volume').shift(5).rollingMean({ windowSize: 5 }).over(g).alias('vol_prev_5'),
    pl.col('high').rollingMax({ windowSize: 60, minPeriods: 1 }).over(g).alias('high_60d'),
    pl.col('low').rollingMin({ windowSize: 60, minPeriods: 1 }).over(g).alias('low_60d'),
    pl.col('close').shift(1).over(g).alias('prev_close'),
    pl.col('limit_up_flag').rollingSum({ windowSize: 20 }).over(g).alias('limit_up_count_20d'),
    pl.col('close').cumCount().over(g).sub(1).alias('bar_idx'),
    // 维度 5 需要个股 lookback 日前的收盘价；与 returnOverWindow 取同一根基准 K 线。
    pl.col('close').shift(relativeStrength.lookback).over(g).alias('close_rs_base'),
  );

  // ---- 4. Derived features ----
  frame = frame.withColumns(
    // Volume ratio (guard division by zero)
    pl.when(pl.col('vol_prev_5').isNull().or(pl.col('vol_prev_5').eq(0)))
      .then(pl.lit(1.0))
      .otherwise(pl.col('vol_recent_5').div(pl.col('vol_prev_5')))
      .alias('volume_ratio'),
    // Price change pct
    pl.when(pl.col('prev_close').isNull().or(pl.col('prev_close').eq(0)))
      .then(pl.lit(0.0))
      .otherwise(pl.col('close').sub(pl.col('prev_close')).div(pl.col('prev_close')).mul(100))
      .alias('price_change_pct'),
    // Distance from 60d high (in %)
    pl.when(pl.col('high_60d').isNull().or(pl.col('high_60d').eq(0)))
      .then(pl.lit(0.0))
      .otherwise(pl.col('close').sub(pl.col('high_60d')).div(pl.col('high_60d')).mul(100))
      .alias('distance_from_high_pct'),
    // Distance from 60d low (in %) — 从60日最低点反弹的涨幅
    pl.when(pl.col('low_60d').isNull().or(pl.col('low_60d').eq(0)))
      .then(pl.lit(0.0))
      .otherwise(pl.col('close').sub(pl.col('low_60d')).div(pl.col('low_60d')).mul(100))
      .alias('distance_from_low_pct'),
  );

  // ---- 5. Alignment classification ----
  frame = frame.withColumns(
    pl.when(pl.col('ma5').isNull().or(pl.col('ma10').isNull()).or(pl.col('ma20').isNull()).or(pl.col('ma60').isNull()))
      .then(pl.lit('tangled'))
      .when(pl.col('ma5').gt(pl.col('ma10')).and(pl.col('ma10').gt(pl.col('ma20'))).and(pl.col('ma20').gt(pl.col('ma60'))))
      .then(pl.lit('bullish'))
      .when(pl.col('ma5').lt(pl.col('ma10')).and(pl.col('ma10').lt(pl.col('ma20'))).and(pl.col('ma20').lt(pl.col('ma60'))))
      .then(pl.lit('bearish'))
      .otherwise(pl.lit('tangled'))
      .alias('alignment'),
  );

  // ---- 6. Dimension 1: Trend score (0-40) ----
  // trendBonus 必须与 scoring-engine.trendScoreFromParts 完全一致：|strength| 未超过
  // trendStrengthThreshold 时为 0（死区）。缺了死区会让回测比实盘多给最多 ±threshold×
  // multiplier 的分，且使 trendStrengthThreshold 这个可优化参数在向量化路径里形同虚设。
  frame = frame.withColumns(
    pl.when(pl.col('trend_strength').gt(trend.trendStrengthThreshold)
      .or(pl.col('trend_strength').lt(-trend.trendStrengthThreshold)))
      .then(pl.col('trend_strength').mul(trend.trendBonusMultiplier).clip(-trend.trendBonusCap, trend.trendBonusCap))
      .otherwise(pl.lit(0))
      .alias('trend_bonus'),
    pl.when(pl.col('sector_state_id').eq(pl.lit(8))
      .or(pl.col('sector_state_id').gtEq(1).and(pl.col('sector_state_id').ltEq(3)))).then(pl.lit(trend.sectorUpBonus))
      .when(pl.col('sector_state_id').gtEq(6)).then(pl.lit(trend.sectorDownBonus))
      .otherwise(pl.lit(0))
      .alias('sector_bonus'),
  ).withColumns(
    pl.when(pl.col('alignment').eq(pl.lit('bullish'))).then(pl.lit(trend.bullishAlignment))
      .when(pl.col('alignment').eq(pl.lit('bearish'))).then(pl.lit(trend.bearishAlignment))
      .otherwise(pl.lit(trend.tangledAlignment))
      .add(pl.col('trend_bonus'))
      .add(pl.col('sector_bonus'))
      .clip(0, 40)
      .alias('trend_score'),
  );

  // ---- 7. Dimension 2: Volume-price score (0-25) ----
  // 必须与 scoring-engine.volumePriceScore 的分支结构逐条对应（位置三分 × 涨跌幅五分）。
  const bigVol = pl.col('volume_ratio').gt(1.5);
  const modVol = pl.col('volume_ratio').gtEq(1.1).and(pl.col('volume_ratio').ltEq(1.5));
  const lowVol = pl.col('volume_ratio').lt(0.8);
  const decline = pl.col('price_change_pct').lt(-1);
  const flat = pl.col('price_change_pct').gtEq(-1).and(pl.col('price_change_pct').ltEq(1));
  const smallGain = pl.col('price_change_pct').gt(1).and(pl.col('price_change_pct').ltEq(3));
  const mildGain = pl.col('price_change_pct').gt(3).and(pl.col('price_change_pct').ltEq(5));
  const bigGain = pl.col('price_change_pct').gt(5);
  const anyGain = pl.col('price_change_pct').gt(1);
  const nearHigh = pl.col('distance_from_high_pct').gt(-5);
  const farHigh = pl.col('distance_from_high_pct').lt(-15);
  const midHigh = nearHigh.not().and(farHigh.not());

  /** 与 volumePriceScore 一一对应的 (条件, 分值, 标签) 表；顺序即分支优先级。 */
  const volumePriceBranches: Array<[ReturnType<typeof pl.col>, number, string]> = [
    [bigVol.and(nearHigh).and(bigGain), 2, '顶部放量'],
    [bigVol.and(nearHigh).and(flat), 1, '高位滞涨'],
    [bigVol.and(nearHigh).and(decline), 2, '放量下跌'],
    [bigVol.and(nearHigh), 8, '高位放量'],
    [bigVol.and(farHigh).and(bigGain.or(mildGain)), 20, '启动放量'],
    [bigVol.and(farHigh).and(smallGain), 18, '低位启动'],
    [bigVol.and(farHigh).and(flat), 10, '放量滞涨'],
    [bigVol.and(farHigh), 2, '放量下跌'],
    [bigVol.and(midHigh).and(bigGain), 12, '追高放量'],
    [bigVol.and(midHigh).and(mildGain), 16, '中位放量'],
    [bigVol.and(midHigh).and(smallGain), 15, '中位放量'],
    [bigVol.and(midHigh).and(flat), 10, '放量滞涨'],
    [bigVol.and(midHigh), 2, '放量下跌'],
    [modVol.and(smallGain).and(nearHigh), 14, '高位稳量'],
    [modVol.and(smallGain), 22, '稳健放量'],
    [modVol.and(mildGain.or(bigGain)), 15, '温和放量'],
    [modVol.and(decline), 8, '健康回调'],
    [modVol, 10, '量价均衡'],
    [lowVol.and(anyGain), 12, '缩量上涨'],
    [lowVol.and(decline), 10, '缩量下跌'],
    [lowVol, 10, '量价均衡'],
  ];

  let volumeScoreExpr = pl.when(pl.col('bar_idx').lt(9)).then(pl.lit(8));
  let volumeLabelExpr = pl.when(pl.col('bar_idx').lt(9)).then(pl.lit('样本不足'));
  for (const [condition, score, label] of volumePriceBranches) {
    volumeScoreExpr = volumeScoreExpr.when(condition).then(pl.lit(score));
    volumeLabelExpr = volumeLabelExpr.when(condition).then(pl.lit(label));
  }

  frame = frame.withColumns(
    volumeScoreExpr.otherwise(pl.lit(10)).alias('volume_price_score'),
    volumeLabelExpr.otherwise(pl.lit('量价均衡')).alias('volume_price_label'),
  );

  // ---- 8. Dimension 3: Distance-from-60d-low score (0-20) ----
  let positionScoreExpr = pl.when(pl.col('distance_from_low_pct').lt(0)).then(pl.lit(distanceFromLow.atLowScore));
  let positionLabelExpr = pl.when(pl.col('distance_from_low_pct').lt(0)).then(pl.lit(distanceTiers[0]?.label ?? '贴近低点'));
  for (const tier of distanceTiers) {
    positionScoreExpr = positionScoreExpr.when(pl.col('distance_from_low_pct').lt(tier.maxPct)).then(pl.lit(tier.score));
    positionLabelExpr = positionLabelExpr.when(pl.col('distance_from_low_pct').lt(tier.maxPct)).then(pl.lit(tier.label));
  }
  frame = frame.withColumns(
    positionScoreExpr.otherwise(pl.lit(distanceFromLow.extendedScore)).alias('position_score'),
    positionLabelExpr.otherwise(pl.lit(distanceFromLow.extendedLabel)).alias('position_label'),
  );

  // ---- 9. Dimension 4: Volatility-trend score (0-15) ----
  // trend_axis: prefer sector state_id when available, fallback to alignment
  frame = frame.withColumns(
    pl.when(pl.col('limit_up_count_20d').gtEq(volatilityTrend.limitUp.highMinLimitUps)).then(pl.lit('high'))
      .when(pl.col('limit_up_count_20d').gtEq(volatilityTrend.limitUp.mediumMinLimitUps)).then(pl.lit('medium'))
      .otherwise(pl.lit('low'))
      .alias('volatility_class'),
    pl.when(pl.col('sector_state_id').eq(pl.lit(8))
      .or(pl.col('sector_state_id').gtEq(1).and(pl.col('sector_state_id').ltEq(3)))).then(pl.lit('up'))
      .when(pl.col('sector_state_id').gtEq(6)).then(pl.lit('down'))
      .when(pl.col('sector_state_id').gtEq(4).and(pl.col('sector_state_id').ltEq(5))).then(pl.lit('range'))
      .when(pl.col('alignment').eq(pl.lit('bullish'))).then(pl.lit('up'))
      .when(pl.col('alignment').eq(pl.lit('bearish'))).then(pl.lit('down'))
      .otherwise(pl.lit('range'))
      .alias('trend_axis'),
  );

  const matrix = volatilityTrend.matrix;
  frame = frame.withColumns(
    pl.when(pl.col('volatility_class').eq(pl.lit('high')))
      .then(pl.when(pl.col('trend_axis').eq(pl.lit('up'))).then(pl.lit(matrix.high.up))
        .when(pl.col('trend_axis').eq(pl.lit('range'))).then(pl.lit(matrix.high.range))
        .otherwise(pl.lit(matrix.high.down)))
      .when(pl.col('volatility_class').eq(pl.lit('medium')))
      .then(pl.when(pl.col('trend_axis').eq(pl.lit('up'))).then(pl.lit(matrix.medium.up))
        .when(pl.col('trend_axis').eq(pl.lit('range'))).then(pl.lit(matrix.medium.range))
        .otherwise(pl.lit(matrix.medium.down)))
      .otherwise(pl.when(pl.col('trend_axis').eq(pl.lit('up'))).then(pl.lit(matrix.low.up))
        .when(pl.col('trend_axis').eq(pl.lit('range'))).then(pl.lit(matrix.low.range))
        .otherwise(pl.lit(matrix.low.down)))
      .alias('volatility_trend_score'),
  );

  // ---- 9b. Dimension 5: Relative strength (0-maxScore) ----
  // 与 scoring-engine.relativeStrengthScore 完全对应：连续线性映射，基准缺失给中性分。
  const { floorPct, capPct, maxScore } = relativeStrength;
  const span = capPct - floorPct;
  const excess = pl.col('close').sub(pl.col('close_rs_base')).div(pl.col('close_rs_base')).mul(100)
    .sub(pl.col('benchmark_return_pct'));
  frame = frame.withColumns(
    pl.when(pl.col('benchmark_known').eq(0).or(pl.col('close_rs_base').isNull()).or(pl.col('close_rs_base').ltEq(0)))
      .then(pl.lit(null))
      .otherwise(excess)
      .alias('relative_strength_pct'),
  ).withColumns(
    pl.when(pl.col('relative_strength_pct').isNull())
      .then(pl.lit(maxScore / 2))
      .otherwise(
        pl.col('relative_strength_pct').sub(floorPct).div(span > 0 ? span : 1).clip(0, 1).mul(maxScore),
      )
      .alias('relative_strength_score'),
    pl.when(pl.col('relative_strength_pct').isNull()).then(pl.lit('基准缺失'))
      .when(pl.col('relative_strength_pct').gtEq(15)).then(pl.lit('显著跑赢'))
      .when(pl.col('relative_strength_pct').gtEq(5)).then(pl.lit('跑赢大盘'))
      .when(pl.col('relative_strength_pct').gt(-5)).then(pl.lit('同步大盘'))
      .when(pl.col('relative_strength_pct').gt(-15)).then(pl.lit('跑输大盘'))
      .otherwise(pl.lit('显著跑输'))
      .alias('relative_strength_label'),
  );

  // ---- 10. Total score（原始满分 RAW_SCORE_MAX，折算到 SCORE_SCALE 的 100 分制）----
  frame = frame.withColumns(
    pl.col('trend_score')
      .add(pl.col('volume_price_score'))
      .add(pl.col('position_score'))
      .add(pl.col('volatility_trend_score'))
      .add(pl.col('relative_strength_score'))
      .mul(SCORE_SCALE / RAW_SCORE_MAX)
      .alias('total_score'),
  );

  // ---- 9. Filter to valid scoring rows and requested dates ----
  frame = frame.filter(
    pl.col('ma20').isNotNull()
      .and(pl.col('volume').gt(0))
      .and(pl.col('open').gt(0))
      .and(pl.col('close').gt(0))
      .and(pl.col('date').isIn([...dateSet])),
  );

  // ---- 10. Extract to JS and group by date ----
  const records = frame.toRecords() as Record<string, unknown>[];
  const byDate = new Map<string, RankingRow[]>();
  for (const row of records) {
    const date = String(row.date);
    const list = byDate.get(date) ?? [];
    list.push({
      rank: 0,
      stock_code: String(row.stock_code),
      stock_name: String(row.stock_name),
      total_score: round(Number(row.total_score), 1),
      trend_score: round(Number(row.trend_score), 1),
      volume_price_score: Number(row.volume_price_score),
      volume_score: Number(row.volume_price_score),
      volume_price_label: String(row.volume_price_label),
      volume_label: String(row.volume_price_label),
      position_score: Number(row.position_score),
      position_label: String(row.position_label),
      volatility_trend_score: Number(row.volatility_trend_score),
      volatility_class: String(row.volatility_class) as VolatilityClass,
      volatility_label: ({ high: '高波动', medium: '中波动', low: '低波动' } as Record<string, string>)[String(row.volatility_class)] ?? '',
      relative_strength_score: round(Number(row.relative_strength_score), 1),
      relative_strength_label: String(row.relative_strength_label),
      relative_strength_pct: row.relative_strength_pct == null ? null : round(Number(row.relative_strength_pct), 2),
      limit_up_count_20d: Number(row.limit_up_count_20d),
      alignment: String(row.alignment),
      trend_strength: round(Number(row.trend_strength), 4),
      distance_from_low_pct: round(Number(row.distance_from_low_pct), 2),
      latest_price: Number(row.close),
      latest_change_rate: Number(row.change_pct),
    });
    byDate.set(date, list);
  }

  // Sort each date's rows by total_score desc, assign ranks
  for (const [, rows] of byDate) {
    rows.sort(compareByScore);
    for (let i = 0; i < rows.length; i += 1) rows[i].rank = i + 1;
  }

  return byDate;
}
