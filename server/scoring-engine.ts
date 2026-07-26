import type { MarketState, RankingRow, StrategyAction } from '../src/types.js';
import { round } from './format.js';
import type { HistoricalBar, HistoricalStockSeries, KLineData } from './historical-market.js';

// ---------------------------------------------------------------------------
// Shared analysis math for the individual-stock 多因子评分 (backtest + live) and
// the index/板块 七种市场状态 classification. Previously this logic lived only,
// and partially, inside backtest-engine.ts (dimension 4 was hardcoded to 8 and
// dimensions 2/3 emitted no labels). Centralising it keeps the backtest scorer,
// the live ranking path and analyzeBlockTrend on a single implementation.
// ---------------------------------------------------------------------------

export interface Bar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  changePct: number;
}

export interface PreparedSeries {
  stockCode: string;
  stockName: string;
  bars: Bar[];
  indexByDate: Map<string, number>;
}

export type Alignment = 'bullish' | 'bearish' | 'tangled';
export type VolatilityClass = 'high' | 'medium' | 'low';
export type TrendAxis = 'up' | 'range' | 'down';

export function toBar(bar: HistoricalBar): Bar {
  return {
    date: bar[0],
    open: Number(bar[1]),
    close: Number(bar[2]),
    high: Number(bar[3]),
    low: Number(bar[4]),
    volume: Number(bar[5]),
    amount: Number(bar[6]),
    changePct: Number(bar[7]),
  };
}

export function prepareSeries(stock: HistoricalStockSeries): PreparedSeries {
  const bars = stock.bars.map(toBar).sort((left, right) => left.date.localeCompare(right.date));
  return {
    stockCode: stock.stock_code,
    stockName: stock.stock_name,
    bars,
    indexByDate: new Map(bars.map((bar, index) => [bar.date, index])),
  };
}

/** 前复权日线（KLineData）转成打分引擎使用的 Bar，缺失涨跌幅时按前收盘补齐。 */
export function klinesToBars(klines: KLineData[]): Bar[] {
  const sorted = [...klines].sort((left, right) => left.date.localeCompare(right.date));
  return sorted.map((kline, index) => {
    const previousClose = index > 0 ? sorted[index - 1].close : kline.open;
    const changePct = kline.changeRate ?? (previousClose > 0 ? (kline.close - previousClose) / previousClose * 100 : 0);
    return {
      date: kline.date,
      open: kline.open,
      close: kline.close,
      high: kline.high,
      low: kline.low,
      volume: kline.volume,
      amount: kline.amount,
      changePct: round(changePct, 2),
    };
  });
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function movingAverage(bars: Bar[], endIndex: number, length: number): number | null {
  if (endIndex + 1 < length) return null;
  return average(bars.slice(endIndex - length + 1, endIndex + 1).map((bar) => bar.close));
}

/** 趋势强度＝最近 lookback 日收盘价线性回归斜率 / 均价。 */
export function trendStrength(bars: Bar[], endIndex: number, lookback = 20): number {
  const closes = bars.slice(Math.max(0, endIndex - lookback + 1), endIndex + 1).map((bar) => bar.close);
  if (closes.length < 5) return 0;
  const n = closes.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let index = 0; index < n; index += 1) {
    sumX += index;
    sumY += closes[index];
    sumXY += index * closes[index];
    sumX2 += index * index;
  }
  const denominator = n * sumX2 - sumX * sumX;
  if (!denominator) return 0;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const mean = sumY / n;
  return mean > 0 ? slope / mean : 0;
}

// ---- ADX / +DI / -DI：趋势强度（不区分方向）+ 方向指示 -------------------
// 经典 Welles Wilder 实现。ADX > 25 视为有趋势，+DI > -DI 为多头，反之空头。
// 与 trendStrength（线性回归斜率）互补：trendStrength 对极端值敏感、ADX 更稳健。

export interface AdxResult {
  /** 平均趋向指数，0-100，> 25 视为有趋势。 */
  adx: number;
  /** 多头方向指标，0-100。 */
  plusDI: number;
  /** 空头方向指标，0-100。 */
  minusDI: number;
  /** +DI - -DI，正为多头、负为空头。 */
  direction: number;
}

/**
 * 计算 ADX/+DI/-DI。需要至少 period*2 根 K 线才稳定。
 * 返回 endIndex 处的指标值；数据不足时返回 adx=0, direction=0。
 */
export function computeADX(bars: Bar[], endIndex: number, period = 14): AdxResult {
  if (endIndex < period) return { adx: 0, plusDI: 0, minusDI: 0, direction: 0 };
  // Wilder 平滑采用累计递推：从第 period 根开始累计，每次按 (prev*(period-1) + new) / period 滚动。
  let prevTR = 0;
  let prevPlusDM = 0;
  let prevMinusDM = 0;
  let adxValue = 0;
  let hasDX = false;
  for (let i = 1; i <= endIndex; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    const trueRange = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    if (i < period) {
      // 累计前 period-1 根，第 period 根开始做 Wilder 平均。
      prevTR += trueRange;
      prevPlusDM += plusDM;
      prevMinusDM += minusDM;
      continue;
    }
    if (i === period) {
      prevTR += trueRange;
      prevPlusDM += plusDM;
      prevMinusDM += minusDM;
    } else {
      prevTR = (prevTR * (period - 1) + trueRange) / period;
      prevPlusDM = (prevPlusDM * (period - 1) + plusDM) / period;
      prevMinusDM = (prevMinusDM * (period - 1) + minusDM) / period;
    }
    if (prevTR <= 0) continue;
    const plusDI = 100 * prevPlusDM / prevTR;
    const minusDI = 100 * prevMinusDM / prevTR;
    const sum = plusDI + minusDI;
    const dx = sum > 0 ? 100 * Math.abs(plusDI - minusDI) / sum : 0;
    if (!hasDX) {
      // 第一个 DX 直接记下，等到再累积 period 个 DX 后开始 Wilder 平滑得到 ADX。
      adxValue = dx;
      hasDX = true;
    } else {
      adxValue = (adxValue * (period - 1) + dx) / period;
    }
  }
  if (!hasDX) return { adx: 0, plusDI: 0, minusDI: 0, direction: 0 };
  const lastPlusDI = prevTR > 0 ? 100 * prevPlusDM / prevTR : 0;
  const lastMinusDI = prevTR > 0 ? 100 * prevMinusDM / prevTR : 0;
  return {
    adx: round(adxValue, 2),
    plusDI: round(lastPlusDI, 2),
    minusDI: round(lastMinusDI, 2),
    direction: round(lastPlusDI - lastMinusDI, 2),
  };
}

export function alignmentOf(
  ma5: number | null,
  ma10: number | null,
  ma20: number | null,
  ma60: number | null,
): Alignment {
  if (ma5 == null || ma10 == null || ma20 == null || ma60 == null) return 'tangled';
  if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) return 'bullish';
  if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) return 'bearish';
  return 'tangled';
}

// ---- 维度 2：价量配合评分（0-25），返回分值与命名标签 -----------------------

export interface VolumePriceScore {
  score: number;
  label: string;
}

export function volumePriceScore(bars: Bar[], endIndex: number): VolumePriceScore {
  if (endIndex < 9) return { score: 8, label: '样本不足' };
  const latest = bars[endIndex];
  const previous = bars[endIndex - 1];
  const recentVolume = average(bars.slice(endIndex - 4, endIndex + 1).map((bar) => bar.volume));
  const previousVolume = average(bars.slice(endIndex - 9, endIndex - 4).map((bar) => bar.volume));
  const volumeRatio = previousVolume > 0 ? recentVolume / previousVolume : 1;
  const priceChangePct = previous.close > 0 ? (latest.close - previous.close) / previous.close * 100 : 0;
  const high = Math.max(...bars.slice(Math.max(0, endIndex - 59), endIndex + 1).map((bar) => bar.high));
  const distanceFromHigh = high > 0 ? (latest.close - high) / high * 100 : 0;
  const nearHigh = distanceFromHigh > -5;
  const farFromHigh = distanceFromHigh < -15;
  const bigVolume = volumeRatio > 1.5;
  const moderateVolume = volumeRatio >= 1.1 && volumeRatio <= 1.5;
  const lowVolume = volumeRatio < 0.8;
  const bigGain = priceChangePct > 5;
  const mildGain = priceChangePct > 3 && priceChangePct <= 5;
  const smallGain = priceChangePct > 0 && priceChangePct <= 3;
  const stagnation = priceChangePct >= -1 && priceChangePct <= 1 && volumeRatio > 1.5;
  const decline = priceChangePct < 0;

  if (bigVolume && bigGain && nearHigh) return { score: 2, label: '顶部放量' };
  if (bigVolume && stagnation && nearHigh) return { score: 1, label: '高位滞涨' };
  if (bigVolume && decline) return { score: 2, label: '放量下跌' };
  if (bigVolume && (bigGain || mildGain) && farFromHigh) return { score: 20, label: '启动放量' };
  if (bigVolume && smallGain && farFromHigh) return { score: 18, label: '低位启动' };
  if (bigVolume && stagnation) return { score: 10, label: '放量滞涨' };
  if (bigVolume && bigGain) return { score: 12, label: '追高放量' };
  if (moderateVolume && smallGain && !nearHigh) return { score: 22, label: '稳健放量' };
  if (moderateVolume && smallGain && nearHigh) return { score: 14, label: '高位稳量' };
  if (moderateVolume && (mildGain || bigGain)) return { score: 15, label: '温和放量' };
  if (moderateVolume && decline) return { score: 8, label: '健康回调' };
  if (lowVolume && priceChangePct > 0) return { score: 12, label: '缩量上涨' };
  if (lowVolume && decline) return { score: 10, label: '缩量下跌' };
  return { score: 10, label: '量价均衡' };
}

// ---- scoreStock 可配置参数（供参数优化与回测复用）---------------------------

export interface DistanceFromLowTier {
  label: string;
  maxPct: number;
  score: number;
}

export interface DistanceFromLowConfig {
  atLowScore: number;
  extendedScore: number;
  extendedLabel: string;
  tiers: DistanceFromLowTier[];
}

export interface TrendScoreConfig {
  bullishAlignment: number;
  tangledAlignment: number;
  bearishAlignment: number;
  trendBonusMultiplier: number;
  trendBonusCap: number;
  trendStrengthThreshold: number;
  sectorUpBonus: number;
  sectorDownBonus: number;
}

export interface VolatilityLimitUpConfig {
  highMinLimitUps: number;
  mediumMinLimitUps: number;
}

export interface VolatilityTrendConfig {
  limitUp: VolatilityLimitUpConfig;
  matrix: Record<VolatilityClass, Record<TrendAxis, number>>;
}

export interface ScoreStockConfig {
  distanceFromLow: DistanceFromLowConfig;
  trend: TrendScoreConfig;
  volatilityTrend: VolatilityTrendConfig;
}

export const DEFAULT_SCORE_STOCK_CONFIG: Readonly<ScoreStockConfig> = Object.freeze({
  distanceFromLow: {
    atLowScore: 2,
    extendedScore: 8,
    extendedLabel: '高位延伸',
    tiers: [
      { label: '贴近低点', maxPct: 5, score: 4 },
      { label: '刚离低点', maxPct: 15, score: 10 },
      { label: '启动确认', maxPct: 30, score: 18 },
      { label: '趋势上行', maxPct: 50, score: 20 },
      { label: '远离低点', maxPct: 80, score: 14 },
    ],
  },
  trend: {
    bullishAlignment: 28,
    tangledAlignment: 14,
    bearishAlignment: 0,
    trendBonusMultiplier: 400,
    trendBonusCap: 12,
    trendStrengthThreshold: 0.003,
    sectorUpBonus: 4,
    sectorDownBonus: -4,
  },
  volatilityTrend: {
    limitUp: { highMinLimitUps: 3, mediumMinLimitUps: 1 },
    matrix: {
      high: { up: 15, range: 8, down: 1 },
      medium: { up: 12, range: 6, down: 3 },
      low: { up: 8, range: 4, down: 5 },
    },
  },
});

export function normalizeScoreStockConfig(overrides?: Partial<ScoreStockConfig>): ScoreStockConfig {
  if (!overrides) return { ...DEFAULT_SCORE_STOCK_CONFIG, distanceFromLow: { ...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow, tiers: [...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow.tiers] }, trend: { ...DEFAULT_SCORE_STOCK_CONFIG.trend }, volatilityTrend: { limitUp: { ...DEFAULT_SCORE_STOCK_CONFIG.volatilityTrend.limitUp }, matrix: { ...DEFAULT_SCORE_STOCK_CONFIG.volatilityTrend.matrix } } };
  return {
    distanceFromLow: {
      ...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow,
      ...overrides.distanceFromLow,
      tiers: overrides.distanceFromLow?.tiers ?? [...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow.tiers],
    },
    trend: { ...DEFAULT_SCORE_STOCK_CONFIG.trend, ...overrides.trend },
    volatilityTrend: {
      limitUp: { ...DEFAULT_SCORE_STOCK_CONFIG.volatilityTrend.limitUp, ...overrides.volatilityTrend?.limitUp },
      matrix: overrides.volatilityTrend?.matrix ?? { ...DEFAULT_SCORE_STOCK_CONFIG.volatilityTrend.matrix },
    },
  };
}

function sortedDistanceTiers(tiers: DistanceFromLowTier[]): DistanceFromLowTier[] {
  return [...tiers].sort((left, right) => left.maxPct - right.maxPct);
}

// ---- 维度 4：波动率-趋势适配评分（0-15）------------------------------------

/** 统计最近 lookback 个交易日的权威涨停记录，只接受同花顺 block_top 日期集合。 */
export function limitUpCount(
  bars: Bar[],
  endIndex: number,
  limitUpDates: ReadonlySet<string>,
  lookback = 20,
): number {
  const start = Math.max(0, endIndex - lookback + 1);
  let count = 0;
  for (let index = start; index <= endIndex; index += 1) {
    const date = bars[index].date.replaceAll('-', '').slice(0, 8);
    if (limitUpDates.has(date)) count += 1;
  }
  return count;
}

export function volatilityClassOf(
  limitUpCount20d: number,
  config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): VolatilityClass {
  const { limitUp } = config.volatilityTrend;
  if (limitUpCount20d >= limitUp.highMinLimitUps) return 'high';
  if (limitUpCount20d >= limitUp.mediumMinLimitUps) return 'medium';
  return 'low';
}

function trendScoreFromParts(
  alignment: Alignment,
  strength: number,
  sectorTrend: TrendAxis | undefined,
  config: ScoreStockConfig,
): number {
  const { trend } = config;
  const alignmentScore = alignment === 'bullish'
    ? trend.bullishAlignment
    : alignment === 'bearish'
      ? trend.bearishAlignment
      : trend.tangledAlignment;
  const trendBonus = strength > trend.trendStrengthThreshold
    ? Math.min(trend.trendBonusCap, strength * trend.trendBonusMultiplier)
    : strength < -trend.trendStrengthThreshold
      ? Math.max(-trend.trendBonusCap, strength * trend.trendBonusMultiplier)
      : 0;
  const sectorBonus = sectorTrend === 'up'
    ? trend.sectorUpBonus
    : sectorTrend === 'down'
      ? trend.sectorDownBonus
      : 0;
  return Math.max(0, Math.min(40, alignmentScore + trendBonus + sectorBonus));
}

/** 用给定 scoreStock 配置合成四维分（供参数优化快速评估）。 */
export function composeDimensionScores(
  input: {
    distanceFromLowPct: number;
    alignment: Alignment;
    trendStrength: number;
    volumePriceScore: number;
    limitUpCount20d: number;
    sectorTrend?: TrendAxis;
  },
  config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
) {
  const trendAxis = input.sectorTrend ?? alignmentToTrendAxis(input.alignment);
  const trendScore = round(trendScoreFromParts(input.alignment, input.trendStrength, input.sectorTrend, config), 1);
  const fromLow = distanceFromLowScore(input.distanceFromLowPct, config);
  const volatility = volatilityClassOf(input.limitUpCount20d, config);
  const volatilityScore = volatilityTrendScore(volatility, trendAxis, config);
  const totalScore = round(trendScore + input.volumePriceScore + fromLow.score + volatilityScore, 1);
  return {
    trendScore,
    positionScore: fromLow.score,
    positionLabel: fromLow.label,
    volatilityScore,
    totalScore,
  };
}

export function volatilityTrendScore(
  volatility: VolatilityClass,
  trend: TrendAxis,
  config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): number {
  return config.volatilityTrend.matrix[volatility][trend];
}

function alignmentToTrendAxis(alignment: Alignment): TrendAxis {
  return alignment === 'bullish' ? 'up' : alignment === 'bearish' ? 'down' : 'range';
}

const VOLATILITY_LABEL: Record<VolatilityClass, string> = { high: '高波动', medium: '中波动', low: '低波动' };

// ---- 维度 3：距60日低点评分（0-20）----------------------------------------

export interface DistanceFromLowScore {
  score: number;
  label: string;
}

/**
 * 距60日低点涨幅 → 位置分。
 * 过低（贴底）与过高（延伸）均降分；15–50% 为启动确认/趋势上行的甜点区。
 */
export function distanceFromLowScore(
  distanceFromLowPct: number,
  config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): DistanceFromLowScore {
  const { distanceFromLow } = config;
  const tiers = sortedDistanceTiers(distanceFromLow.tiers);
  if (!Number.isFinite(distanceFromLowPct) || distanceFromLowPct < 0) {
    return { score: distanceFromLow.atLowScore, label: tiers[0]?.label ?? '贴近低点' };
  }
  for (const tier of tiers) {
    if (distanceFromLowPct < tier.maxPct) return { score: tier.score, label: tier.label };
  }
  return { score: distanceFromLow.extendedScore, label: distanceFromLow.extendedLabel };
}

export function distanceTierForPct(distanceFromLowPct: number, config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG) {
  return distanceFromLowScore(distanceFromLowPct, config);
}

/** 打分时可传入板块趋势上下文，用于维度 1 板块加分与维度 4 的趋势轴。 */
export interface SectorContext {
  trend?: TrendAxis;
  trendName?: string;
  stateId?: number;
  code?: string;
  name?: string;
  /** 该股票由 block_top 确认的涨停日期；不能用日涨幅反推。 */
  limitUpDates?: ReadonlySet<string>;
}

/**
 * 个股四维评分：K线趋势(40) + 价量配合(25) + 距60日低点(20) + 波动率-趋势适配(15)。
 * 仅使用 date 当日及之前的 K 线，无未来数据。
 */
export function scoreStock(
  series: PreparedSeries,
  date: string,
  sector?: SectorContext,
  config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): RankingRow | null {
  const endIndex = series.indexByDate.get(date);
  if (endIndex == null || endIndex < 19) return null;
  const latest = series.bars[endIndex];
  if (!latest.volume || latest.open <= 0 || latest.close <= 0) return null;

  const ma5 = movingAverage(series.bars, endIndex, 5);
  const ma10 = movingAverage(series.bars, endIndex, 10);
  const ma20 = movingAverage(series.bars, endIndex, 20);
  const ma60 = movingAverage(series.bars, endIndex, 60);
  const low60 = Math.min(...series.bars.slice(Math.max(0, endIndex - 59), endIndex + 1).map((bar) => bar.low));
  const distanceFromLowPct = low60 > 0 ? round((latest.close - low60) / low60 * 100, 2) : 0;
  const strength = trendStrength(series.bars, endIndex);
  const alignment = alignmentOf(ma5, ma10, ma20, ma60);
  const trendAxis = sector?.trend ?? alignmentToTrendAxis(alignment);

  const trendScore = trendScoreFromParts(alignment, strength, sector?.trend, config);
  const volumePrice = volumePriceScore(series.bars, endIndex);
  const fromLow = distanceFromLowScore(distanceFromLowPct, config);
  const limitUps = limitUpCount(series.bars, endIndex, sector?.limitUpDates ?? new Set());
  const volatility = volatilityClassOf(limitUps, config);
  const volatilityTrend = volatilityTrendScore(volatility, trendAxis, config);

  const totalScore = round(trendScore + volumePrice.score + fromLow.score + volatilityTrend, 1);

  return {
    rank: 0,
    stock_code: series.stockCode,
    stock_name: series.stockName,
    total_score: totalScore,
    trend_score: round(trendScore, 1),
    volume_price_score: volumePrice.score,
    volume_score: volumePrice.score,
    volume_price_label: volumePrice.label,
    volume_label: volumePrice.label,
    position_score: fromLow.score,
    position_label: fromLow.label,
    volatility_trend_score: volatilityTrend,
    volatility_class: volatility,
    volatility_label: VOLATILITY_LABEL[volatility],
    limit_up_count_20d: limitUps,
    alignment,
    trend_strength: round(strength, 4),
    distance_from_low_pct: distanceFromLowPct,
    sector_code: sector?.code,
    sector_name: sector?.name,
    sector_trend_name: sector?.trendName,
    sector_trend_state_id: sector?.stateId,
    latest_price: latest.close,
    latest_change_rate: latest.changePct,
  };
}

/** 建议仓位系数（0.x），最终仓位 = 系数 × 单票仓位上限（%）。满分 100。 */
export function positionRatioForScore(score: number): number {
  if (score >= 70) return 0.8;
  if (score >= 55) return 0.6;
  if (score >= 40) return 0.4;
  if (score >= 25) return 0.2;
  if (score >= 10) return 0.05;
  return 0;
}

export function formatPositionRatio(ratio: number): string {
  return Number(ratio.toFixed(2)).toString();
}

export function suggestedPositionPct(ratio: number, positionSizePct: number): number {
  return round(ratio * positionSizePct, 1);
}

export function strategyForScore(score: number): Pick<RankingRow, 'strategy_action' | 'strategy_label' | 'strategy_position' | 'strategy_position_ratio'> {
  const strategy_position_ratio = positionRatioForScore(score);
  if (score >= 70) return { strategy_action: 'accumulate', strategy_label: '重点加仓', strategy_position_ratio, strategy_position: formatPositionRatio(strategy_position_ratio) };
  if (score >= 55) return { strategy_action: 'accumulate', strategy_label: '趋势跟踪', strategy_position_ratio, strategy_position: formatPositionRatio(strategy_position_ratio) };
  if (score >= 40) return { strategy_action: 'trade', strategy_label: '短线博弈', strategy_position_ratio, strategy_position: formatPositionRatio(strategy_position_ratio) };
  if (score >= 25) return { strategy_action: 'trade', strategy_label: '轻仓试探', strategy_position_ratio, strategy_position: formatPositionRatio(strategy_position_ratio) };
  if (score >= 10) return { strategy_action: 'reduce', strategy_label: '观望减仓', strategy_position_ratio, strategy_position: formatPositionRatio(strategy_position_ratio) };
  return { strategy_action: 'ignore', strategy_label: '坚决回避', strategy_position_ratio, strategy_position: formatPositionRatio(strategy_position_ratio) };
}

// ---- 八种市场状态分类（ref-doc §3.1 + 筑底成功）--------------------------------------

export interface MarketStateResult extends MarketState {
  signal: 'buy' | 'sell' | 'hold' | 'empty';
  latest: number | null;
  ma5: number | null;
  ma20: number | null;
  near_high: string;
  volume_trend: string;
  /** ADX 指标值，0-100，> 20 视为有趋势。 */
  adx?: number;
  /** +DI 多头方向指标。 */
  plus_di?: number;
  /** -DI 空头方向指标。 */
  minus_di?: number;
  downgraded?: boolean;
  /** 日线原始分类的 state_id；analyzeBlockTrend 在降级/升级时保留以供审计。 */
  original_state_id?: number;
  original_state_name?: string;
}

interface StateTemplate {
  state_id: number;
  state_name: string;
  trend: '上升' | '横盘' | '下跌' | '未知';
  position: string;
  signal: 'buy' | 'sell' | 'hold' | 'empty';
}

const STATE_TABLE: Record<number, StateTemplate> = {
  0: { state_id: 0, state_name: '数据不足', trend: '未知', position: '0成', signal: 'empty' },
  1: { state_id: 1, state_name: '主线主升', trend: '上升', position: '7-9成', signal: 'buy' },
  2: { state_id: 2, state_name: '高位滞涨', trend: '上升', position: '3-5成', signal: 'sell' },
  3: { state_id: 3, state_name: '首次回调', trend: '上升', position: '3-5成', signal: 'sell' },
  4: { state_id: 4, state_name: '箱体震荡', trend: '横盘', position: '0-3成', signal: 'hold' },
  5: { state_id: 5, state_name: '缩量无序', trend: '横盘', position: '0成', signal: 'empty' },
  6: { state_id: 6, state_name: '阴跌不止', trend: '下跌', position: '0成', signal: 'empty' },
  7: { state_id: 7, state_name: '恐慌暴跌', trend: '下跌', position: '0-1成', signal: 'empty' },
  8: { state_id: 8, state_name: '筑底成功', trend: '横盘', position: '1', signal: 'buy' },
};

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function volumeTrendRatio(bars: Bar[], endIndex: number): number {
  if (endIndex < 9) return 1;
  const recentVolume = average(bars.slice(endIndex - 4, endIndex + 1).map((bar) => bar.volume));
  const previousVolume = average(bars.slice(endIndex - 9, endIndex - 4).map((bar) => bar.volume));
  return previousVolume > 0 ? recentVolume / previousVolume : 1;
}

function buildStateResult(templateId: number, bars: Bar[], extra: Partial<MarketStateResult> = {}): MarketStateResult {
  const template = STATE_TABLE[templateId] ?? STATE_TABLE[0];
  const endIndex = bars.length - 1;
  const ma5 = movingAverage(bars, endIndex, 5);
  const ma20 = movingAverage(bars, endIndex, 20);
  const latest = endIndex >= 0 ? bars[endIndex].close : null;
  const high60 = bars.length ? Math.max(...bars.slice(Math.max(0, endIndex - 59), endIndex + 1).map((bar) => bar.high)) : 0;
  const distanceFromHigh = high60 > 0 && latest != null ? (latest - high60) / high60 * 100 : 0;
  const volumeRatio = volumeTrendRatio(bars, endIndex);
  return {
    state_id: template.state_id,
    state_name: template.state_name,
    trend: template.trend,
    position: template.position,
    signal: template.signal,
    latest,
    ma5: ma5 == null ? null : round(ma5, 2),
    ma20: ma20 == null ? null : round(ma20, 2),
    near_high: `${round(distanceFromHigh, 1)}%`,
    volume_trend: volumeRatio >= 1.1 ? '放量' : volumeRatio <= 0.8 ? '缩量' : '平量',
    ...extra,
  };
}

/** 八态分类的阈值参数；供参数优化与测试覆盖。 */
export interface MarketStateThresholds {
  /** trendStrength（线性回归斜率/均价）超过此值视为上升。 */
  risingStrength: number;
  /** trendStrength 低于此值的负数视为下降。 */
  fallingStrength: number;
  /** ADX 高于此值视为有趋势（与 trendStrength 双确认）。 */
  adxTrending: number;
  /** ADX 方向（+DI - -DI）正负方向阈值，绝对值小于此值视为方向不明。 */
  adxDirectionDeadZone: number;
  /** 距 60 日高点小于此距离（百分比/100）视为「接近高点」。 */
  nearHighDistance: number;
  /** 距 60 日高点小于此负距离视为「回调中」。 */
  pullbackDistance: number;
  /** 5 日累计涨幅超过此值视为恐慌抛售。 */
  panicReturn5: number;
  /** 日收益率标准差超过此值视为恐慌抛售。 */
  panicVolatility: number;
  /** 量比低于此值视为缩量。 */
  dryVolumeRatio: number;
  /** 量比高于此值视为放量。 */
  heavyVolumeRatio: number;
  /** 「筑底成功」5 日累计涨幅上限。 */
  bottomingMaxReturn5: number;
  /** 「筑底成功」5 日累计涨幅下限。 */
  bottomingMinReturn5: number;
  /** 「筑底成功」距高点负距离下限（必须 <= 此负值）。 */
  bottomingMinDistanceFromHigh: number;
}

export const DEFAULT_MARKET_STATE_THRESHOLDS: Readonly<MarketStateThresholds> = Object.freeze({
  risingStrength: 0.003,
  fallingStrength: -0.003,
  adxTrending: 20,
  adxDirectionDeadZone: 3,
  nearHighDistance: -0.03,
  pullbackDistance: -0.05,
  panicReturn5: -0.08,
  panicVolatility: 4.5,
  dryVolumeRatio: 0.8,
  heavyVolumeRatio: 1.1,
  bottomingMaxReturn5: 0.08,
  bottomingMinReturn5: 0.02,
  bottomingMinDistanceFromHigh: -0.08,
});

/**
 * 八种市场状态分类：均线排列 + ADX → 距高点 → 量能 → 波动率。
 * ADX 用于趋势确认：ADX 不足时即使 trendStrength 略偏也视为震荡市。
 */
export function classifyMarketState(
  bars: Bar[],
  thresholds: MarketStateThresholds = DEFAULT_MARKET_STATE_THRESHOLDS,
): MarketStateResult {
  if (bars.length < 20) return buildStateResult(0, bars);
  const endIndex = bars.length - 1;
  const ma5 = movingAverage(bars, endIndex, 5);
  const ma10 = movingAverage(bars, endIndex, 10);
  const ma20 = movingAverage(bars, endIndex, 20);
  const ma60 = movingAverage(bars, endIndex, 60);
  const alignment = alignmentOf(ma5, ma10, ma20, ma60);
  const strength = trendStrength(bars, endIndex, 20);
  const adx = computeADX(bars, endIndex, 14);
  const close = bars[endIndex].close;
  const high60 = Math.max(...bars.slice(Math.max(0, endIndex - 59), endIndex + 1).map((bar) => bar.high));
  const distanceFromHigh = high60 > 0 ? (close - high60) / high60 : 0;
  const referenceClose = bars[Math.max(0, endIndex - 5)].close;
  const return5 = referenceClose > 0 ? (close - referenceClose) / referenceClose : 0;
  const volumeRatio = volumeTrendRatio(bars, endIndex);
  const volatility = standardDeviation(bars.slice(Math.max(0, endIndex - 19), endIndex + 1).map((bar) => bar.changePct));

  // 趋势确认：均线排列明确 OR (trendStrength 越线 AND ADX 足够强)。
  // ADX < thresholds.adxTrending 时降级为震荡市，避免在震荡市误判。
  const adxTrending = adx.adx >= thresholds.adxTrending;
  const adxBullish = adx.direction > thresholds.adxDirectionDeadZone;
  const adxBearish = adx.direction < -thresholds.adxDirectionDeadZone;
  const rising = alignment === 'bullish' || (strength > thresholds.risingStrength && adxTrending && adxBullish);
  const falling = alignment === 'bearish' || (strength < thresholds.fallingStrength && adxTrending && adxBearish);

  const bottomingSuccess = !rising
    && return5 >= thresholds.bottomingMinReturn5
    && return5 <= thresholds.bottomingMaxReturn5
    && volumeRatio >= thresholds.heavyVolumeRatio
    && distanceFromHigh <= thresholds.bottomingMinDistanceFromHigh
    && strength > -0.005;

  if (bottomingSuccess) {
    return buildStateResult(8, bars, { adx: adx.adx, plus_di: adx.plusDI, minus_di: adx.minusDI });
  }

  let stateId: number;
  if (rising && !falling) {
    if (distanceFromHigh > thresholds.nearHighDistance) {
      stateId = volumeRatio >= 0.9 ? 1 : 2;
    } else if (distanceFromHigh <= thresholds.pullbackDistance) {
      stateId = 3;
    } else {
      stateId = 1;
    }
  } else if (falling && !rising) {
    stateId = (return5 <= thresholds.panicReturn5 || volatility >= thresholds.panicVolatility) ? 7 : 6;
  } else {
    stateId = volumeRatio < thresholds.dryVolumeRatio ? 5 : 4;
  }
  return buildStateResult(stateId, bars, { adx: adx.adx, plus_di: adx.plusDI, minus_di: adx.minusDI });
}

/** 周/月线粗判断：ADX 方向 + 斜率共振 → up / down / range。 */
export function singlePeriodTrend(bars: Bar[]): TrendAxis {
  if (bars.length < 14) return 'range';
  const endIndex = bars.length - 1;
  const strength = trendStrength(bars, endIndex, Math.min(bars.length, 12));
  const adx = computeADX(bars, endIndex, 14);
  if (adx.adx < 15) return 'range'; // ADX 太低，方向不可信
  const slopeUp = strength > 0.003 || adx.direction > 3;
  const slopeDown = strength < -0.003 || adx.direction < -3;
  if (slopeUp && !slopeDown) return 'up';
  if (slopeDown && !slopeUp) return 'down';
  return 'range';
}

/**
 * 板块趋势分析：日线七态分类 + 周/月线交叉验证。
 *
 * 多周期共振规则（周月线长度足够时生效）：
 * 1. 日线上升 + 周月均下跌 → 降级为「阴跌不止」（日线反弹 trap）。
 * 2. 日线 state 8（筑底成功） + 周月均下跌 → 抑制为「阴跌不止」（假底部）。
 * 3. 日线下跌 + 周月均上升 → 升级为「筑底成功」（多周期底部共振）。
 * 4. 其他情况保留日线分类。
 */
export function analyzeBlockTrend(daily: Bar[], weekly?: Bar[], monthly?: Bar[]): MarketStateResult {
  const state = classifyMarketState(daily);
  const hasWeekly = (weekly?.length ?? 0) >= 14;
  const hasMonthly = (monthly?.length ?? 0) >= 14;
  if (!hasWeekly || !hasMonthly) return state;

  const weeklyTrend = singlePeriodTrend(weekly!);
  const monthlyTrend = singlePeriodTrend(monthly!);
  const bothDown = weeklyTrend === 'down' && monthlyTrend === 'down';
  const bothUp = weeklyTrend === 'up' && monthlyTrend === 'up';

  // 1. 日线上升 + 周月均下跌 → 降级为「阴跌不止」。
  if (state.trend === '上升' && bothDown) {
    return buildStateResult(6, daily, {
      downgraded: true,
      original_state_id: state.state_id,
      original_state_name: state.state_name,
      adx: state.adx,
      plus_di: state.plus_di,
      minus_di: state.minus_di,
    });
  }

  // 2. 日线 state 8（筑底成功） + 周月均下跌 → 抑制为「阴跌不止」。
  if (state.state_id === 8 && bothDown) {
    return buildStateResult(6, daily, {
      downgraded: true,
      original_state_id: state.state_id,
      original_state_name: state.state_name,
      adx: state.adx,
      plus_di: state.plus_di,
      minus_di: state.minus_di,
    });
  }

  // 3. 日线下跌 + 周月均上升 → 升级为「筑底成功」（多周期底部共振）。
  if (state.trend === '下跌' && bothUp) {
    return buildStateResult(8, daily, {
      downgraded: true,
      original_state_id: state.state_id,
      original_state_name: state.state_name,
      adx: state.adx,
      plus_di: state.plus_di,
      minus_di: state.minus_di,
    });
  }

  return state;
}

// ---- 板块策略矩阵（ref-doc §3.3）------------------------------------------

export interface BlockStrategy {
  action: StrategyAction;
  label: string;
  position: string;
}

const BLOCK_STRATEGY_ACTION: Record<string, StrategyAction> = {
  主线主升: 'accumulate',
  趋势跟踪: 'trade',
  逢高减仓: 'reduce',
  博反抽: 'trade',
  情绪博弈: 'trade',
  箱体操作: 'trade',
  超跌反弹: 'trade',
  筑底成功: 'accumulate',
  休息: 'ignore',
  回避: 'ignore',
};

function strategyFor(label: string, position: string): BlockStrategy {
  return { action: BLOCK_STRATEGY_ACTION[label] ?? 'ignore', label, position };
}

/** 状态 × 涨停热度 → 板块策略（涨停≥5 且连板≥2 视为高热度）。 */
export function blockStrategy(stateId: number, limitUpNum: number, maxContinue: number): BlockStrategy {
  const hot = limitUpNum >= 5 && maxContinue >= 2;
  switch (stateId) {
    case 1: return hot ? strategyFor('主线主升', '7-9成') : strategyFor('趋势跟踪', '3-5成');
    case 2: return strategyFor('逢高减仓', '3-5成');
    case 3: return strategyFor('博反抽', '3-5成');
    case 4: return hot ? strategyFor('情绪博弈', '3-5成') : strategyFor('箱体操作', '0-3成');
    case 5: return strategyFor('休息', '0成');
    case 6: return strategyFor('回避', '0成');
    case 7: return hot ? strategyFor('超跌反弹', '0-1成') : strategyFor('回避', '0成');
    case 8: return strategyFor('筑底成功', '1');
    default: return strategyFor('回避', '0成');
  }
}
