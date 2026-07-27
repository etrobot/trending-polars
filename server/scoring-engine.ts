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
  /** 平均趋向指数，0-100，> 25 视为有趋势。未完成预热时为 0，须先检查 `warm`。 */
  adx: number;
  /** 多头方向指标，0-100。 */
  plusDI: number;
  /** 空头方向指标，0-100。 */
  minusDI: number;
  /** +DI - -DI，正为多头、负为空头。 */
  direction: number;
  /**
   * ADX 是否已完成预热（需 `period*2` 根 K 线：period 根喂 DI 平滑 + period 个 DX 做种子）。
   * 为 false 时 `adx` 不可信，调用方**不得**把它当作「无趋势」，否则会在样本不足时
   * 系统性地把所有趋势压成震荡。
   */
  warm: boolean;
}

/** ADX 完成预热所需的最少 K 线数（period=14 → 28）。周/月线共振判定同样受此约束。 */
export const MIN_HIGHER_TIMEFRAME_BARS = 28;

/**
 * 板块状态分类使用的日线窗口长度。
 *
 * 必须在实盘与回测两条路径上取同一个值：ADX 的 Wilder 平滑是路径依赖的（IIR），
 * 喂 60 根和喂 250 根会在同一日给出不同的 ADX，进而可能跨过 `adxTrending` 门槛
 * 得到不同的 state_id —— 回测结论就无法外推到实盘。
 * 120 根 = MA60 所需的 60 根 + 富余的 ADX 预热区间。
 */
export const SECTOR_STATE_WINDOW_BARS = 120;

/** 周/月线共振判定使用的窗口长度；与日线同理，两条路径必须取同一值。 */
export const HIGHER_TIMEFRAME_WINDOW_BARS = 60;

/**
 * 计算 ADX/+DI/-DI（Welles Wilder）。
 *
 * ADX 的种子取前 `period` 个 DX 的算术平均（Wilder 原始定义），此后才做递推平滑。
 * 早前的实现把**第一个** DX 直接当种子，导致同一根 K 线喂入不同长度历史时 ADX 从
 * 3.7 摆到 38.8、方向甚至翻转，而 `adx >= 20` 的门槛正好被这段噪音跨越。
 */
export function computeADX(bars: Bar[], endIndex: number, period = 14): AdxResult {
  if (endIndex < period) return { adx: 0, plusDI: 0, minusDI: 0, direction: 0, warm: false };
  // Wilder 平滑采用累计递推：从第 period 根开始累计，每次按 (prev*(period-1) + new) / period 滚动。
  let prevTR = 0;
  let prevPlusDM = 0;
  let prevMinusDM = 0;
  const dxSeed: number[] = [];
  let adxValue = 0;
  let adxStarted = false;
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
    if (!adxStarted) {
      // Wilder 种子：前 period 个 DX 的算术平均，凑满之前不产出 ADX。
      dxSeed.push(dx);
      if (dxSeed.length >= period) {
        adxValue = dxSeed.reduce((sum_, value) => sum_ + value, 0) / dxSeed.length;
        adxStarted = true;
      }
    } else {
      adxValue = (adxValue * (period - 1) + dx) / period;
    }
  }
  const lastPlusDI = prevTR > 0 ? 100 * prevPlusDM / prevTR : 0;
  const lastMinusDI = prevTR > 0 ? 100 * prevMinusDM / prevTR : 0;
  return {
    adx: adxStarted ? round(adxValue, 2) : 0,
    plusDI: round(lastPlusDI, 2),
    minusDI: round(lastMinusDI, 2),
    direction: round(lastPlusDI - lastMinusDI, 2),
    warm: adxStarted,
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

/**
 * 维度 2：价量配合（0-25）。
 *
 * 两处历史缺陷已修复：
 *
 * 1. **中间位置的分支空洞**：`启动放量` 要求 farHigh(<-15%)、`追高放量` 只认 bigGain(>5%)，
 *    于是「放量 + 涨 4% + 距高点 -10%」谁都不命中，掉进兜底的「量价均衡」拿 10 分 ——
 *    标签和分值都是错的。现补 `中位放量` 分支承接这一段。
 * 2. **0% 附近的悬崖**：`bigVolume && decline` 排在 `bigVolume && stagnation` 之前，
 *    导致放量微跌 -0.5% 判「放量下跌」2 分、微涨 +0.5% 判「低位启动」18 分 ——
 *    1 个百分点的日内噪音造成 16 分跳变。现将滞涨区（±1%）统一交给 stagnation 分支处理，
 *    并对区间边界做线性插值（见 blendScore），把台阶抹成斜坡。
 */
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

  // 位置三分：近高点 / 中位 / 远离高点（互斥且穷尽）。
  const nearHigh = distanceFromHigh > -5;
  const farFromHigh = distanceFromHigh < -15;
  const midHigh = !nearHigh && !farFromHigh;

  // 涨跌幅五分：互斥且穷尽，且**滞涨区跨 0 对称**。
  // 旧实现里 decline(<0) 与 stagnation([-1,1]) 重叠，且 decline 分支排在前面，
  // 于是 -0.5% 判「放量下跌」2 分、+0.5% 判「低位启动」18 分 —— 1 个百分点造成 16 分跳变。
  const decline = priceChangePct < -1;
  const flat = priceChangePct >= -1 && priceChangePct <= 1;
  const smallGain = priceChangePct > 1 && priceChangePct <= 3;
  const mildGain = priceChangePct > 3 && priceChangePct <= 5;
  const bigGain = priceChangePct > 5;

  const bigVolume = volumeRatio > 1.5;
  const moderateVolume = volumeRatio >= 1.1 && volumeRatio <= 1.5;
  const lowVolume = volumeRatio < 0.8;

  if (bigVolume) {
    if (nearHigh) {
      if (bigGain) return { score: 2, label: '顶部放量' };
      if (flat) return { score: 1, label: '高位滞涨' };
      if (decline) return { score: 2, label: '放量下跌' };
      return { score: 8, label: '高位放量' };
    }
    if (farFromHigh) {
      if (bigGain || mildGain) return { score: 20, label: '启动放量' };
      if (smallGain) return { score: 18, label: '低位启动' };
      if (flat) return { score: 10, label: '放量滞涨' };
      return { score: 2, label: '放量下跌' };
    }
    // 中位（距高点 -15% ~ -5%）过去无人接手，mildGain 会掉进兜底的「量价均衡」10 分。
    if (bigGain) return { score: 12, label: '追高放量' };
    if (mildGain) return { score: 16, label: '中位放量' };
    if (smallGain) return { score: 15, label: '中位放量' };
    if (flat) return { score: 10, label: '放量滞涨' };
    return { score: 2, label: '放量下跌' };
  }

  if (moderateVolume) {
    if (smallGain) return nearHigh ? { score: 14, label: '高位稳量' } : { score: 22, label: '稳健放量' };
    if (mildGain || bigGain) return { score: 15, label: '温和放量' };
    if (decline) return { score: 8, label: '健康回调' };
    return { score: 10, label: '量价均衡' };
  }

  if (lowVolume) {
    if (smallGain || mildGain || bigGain) return { score: 12, label: '缩量上涨' };
    if (decline) return { score: 10, label: '缩量下跌' };
    return { score: 10, label: '量价均衡' };
  }

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

/** 维度 5：相对强度（个股 N 日收益 − 基准 N 日收益）。 */
export interface RelativeStrengthConfig {
  /** 回看窗口（交易日）。 */
  lookback: number;
  /** 超额收益低于此值（百分点）得 0 分。 */
  floorPct: number;
  /** 超额收益高于此值（百分点）得满分。 */
  capPct: number;
  /** 本维度满分。 */
  maxScore: number;
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
  /** 上升趋势中量能「健康」的下限；低于此值视为缩量滞涨（state 2）。 */
  risingVolumeRatio: number;
  /** 周/月线粗趋势判定所需的最低 ADX。 */
  higherTimeframeAdxMin: number;
  /** 「筑底成功」5 日累计涨幅上限。 */
  bottomingMaxReturn5: number;
  /** 「筑底成功」5 日累计涨幅下限。 */
  bottomingMinReturn5: number;
  /** 「筑底成功」距高点负距离下限（必须 <= 此负值）。 */
  bottomingMinDistanceFromHigh: number;
  /**
   * 「筑底成功」所需的确认项总数（共 4 项，见 bottomingConfirmations）。
   * 无论此值多低，都**额外**强制至少 1 项结构类证据 —— 否则一根长阳就能点亮两项动量证据。
   */
  bottomingMinConfirmations: number;
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
  risingVolumeRatio: 0.9,
  higherTimeframeAdxMin: 15,
  bottomingMaxReturn5: 0.08,
  bottomingMinReturn5: 0.02,
  bottomingMinDistanceFromHigh: -0.08,
  bottomingMinConfirmations: 2,
});

export interface ScoreStockConfig {
  distanceFromLow: DistanceFromLowConfig;
  trend: TrendScoreConfig;
  volatilityTrend: VolatilityTrendConfig;
  relativeStrength: RelativeStrengthConfig;
  /**
   * 八态分类阈值。挂在 ScoreStockConfig 上是为了复用既有的
   * 配置 → SQLite → 回测/实盘两条打分路径的传递链路，而不是再造一套。
   * 过去这组阈值虽然定义了 MarketStateThresholds 类型，却没有任何调用方能传进来。
   */
  marketState: MarketStateThresholds;
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
    // 列（同一趋势下比波动率）：下跌市里低波动受损最小，故 down 列 low > medium > high —— 这是刻意的。
    // 行（同一波动率下比趋势）：必须 up > range > down。旧的 low 行是 8/4/5，
    // 「低波动 + 下跌」竟然比「低波动 + 震荡」高 1 分，是唯一一处行内倒挂，这里改为 8/5/4，
    // 同时保住 down 列 4 > 3 > 1 的列序。
    matrix: {
      high: { up: 15, range: 8, down: 1 },
      medium: { up: 12, range: 6, down: 3 },
      low: { up: 8, range: 5, down: 4 },
    },
  },
  relativeStrength: {
    lookback: 20,
    floorPct: -15,
    capPct: 25,
    maxScore: 20,
  },
  marketState: DEFAULT_MARKET_STATE_THRESHOLDS,
});

export function normalizeScoreStockConfig(overrides?: Partial<ScoreStockConfig>): ScoreStockConfig {
  const base = DEFAULT_SCORE_STOCK_CONFIG;
  return {
    distanceFromLow: {
      ...base.distanceFromLow,
      ...overrides?.distanceFromLow,
      tiers: overrides?.distanceFromLow?.tiers ?? [...base.distanceFromLow.tiers],
    },
    trend: { ...base.trend, ...overrides?.trend },
    volatilityTrend: {
      limitUp: { ...base.volatilityTrend.limitUp, ...overrides?.volatilityTrend?.limitUp },
      matrix: overrides?.volatilityTrend?.matrix ?? {
        high: { ...base.volatilityTrend.matrix.high },
        medium: { ...base.volatilityTrend.matrix.medium },
        low: { ...base.volatilityTrend.matrix.low },
      },
    },
    relativeStrength: { ...base.relativeStrength, ...overrides?.relativeStrength },
    marketState: { ...base.marketState, ...overrides?.marketState },
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

// ---- 维度 5：相对强度（0-20）------------------------------------------------

/** 各维度原始满分。加总为 RAW_SCORE_MAX，对外统一折算到 SCORE_SCALE（100 分制）。 */
export const DIMENSION_MAX = {
  trend: 40,
  volumePrice: 25,
  distanceFromLow: 20,
  volatilityTrend: 15,
  relativeStrength: 20,
} as const;

export const RAW_SCORE_MAX = DIMENSION_MAX.trend + DIMENSION_MAX.volumePrice
  + DIMENSION_MAX.distanceFromLow + DIMENSION_MAX.volatilityTrend + DIMENSION_MAX.relativeStrength;

/**
 * 对外的总分标度。四维时代 RAW_SCORE_MAX 恰为 100，加入维度 5 后原始满分变成 120，
 * 若不折算，下游所有绝对阈值（入场线 40、策略分档 70/55/40/25/10）的含义都会漂移。
 */
export const SCORE_SCALE = 100;

/** N 日累计收益率（%）。样本不足时返回 null。 */
export function returnOverWindow(bars: Bar[], endIndex: number, lookback: number): number | null {
  const startIndex = endIndex - lookback;
  if (startIndex < 0) return null;
  const base = bars[startIndex].close;
  if (!(base > 0)) return null;
  return (bars[endIndex].close - base) / base * 100;
}

export interface RelativeStrengthScore {
  score: number;
  label: string;
  /** 超额收益（个股 − 基准），百分点。基准缺失时为 null。 */
  excessPct: number | null;
}

/**
 * 相对强度评分：个股 N 日收益 − 基准（上证指数）N 日收益，线性映射到 0~maxScore。
 *
 * 补上的是原本整套评分里最大的缺口 —— README 的核心逻辑写着「指数定仓位」，
 * 但四个维度全是绝对口径（距 60 日高/低点、均线排列、量比），没有任何一项衡量个股
 * 相对大盘的强弱。牛市里所有股票的位置分一起上移、熊市一起下移，截面区分度被系统性压缩。
 *
 * 本维度刻意做成**连续**映射而非分档，不引入新的阈值悬崖。
 */
export function relativeStrengthScore(
  stockReturnPct: number | null,
  benchmarkReturnPct: number | null | undefined,
  config: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): RelativeStrengthScore {
  const { floorPct, capPct, maxScore } = config.relativeStrength;
  // 基准缺失时给中性分，既不奖励也不惩罚 —— 否则没有指数数据的日期会整体塌陷。
  if (stockReturnPct == null || benchmarkReturnPct == null || !Number.isFinite(benchmarkReturnPct)) {
    return { score: round(maxScore / 2, 1), label: '基准缺失', excessPct: null };
  }
  const excess = stockReturnPct - benchmarkReturnPct;
  const span = capPct - floorPct;
  const ratio = span > 0 ? Math.min(1, Math.max(0, (excess - floorPct) / span)) : 0.5;
  const label = excess >= 15 ? '显著跑赢'
    : excess >= 5 ? '跑赢大盘'
      : excess > -5 ? '同步大盘'
        : excess > -15 ? '跑输大盘'
          : '显著跑输';
  return { score: round(ratio * maxScore, 1), label, excessPct: round(excess, 2) };
}


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
  /** 基准（上证指数）在同一窗口的收益率(%)，用于维度 5 相对强度。缺失时该维度给中性分。 */
  benchmarkReturnPct?: number | null;
}

/**
 * 个股五维评分：K线趋势(40) + 价量配合(25) + 距60日低点(20) + 波动率-趋势适配(15) + 相对强度(20)。
 * 原始满分 120，对外折算到 100 分制（见 SCORE_SCALE）。
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
  const stockReturn = returnOverWindow(series.bars, endIndex, config.relativeStrength.lookback);
  const relativeStrength = relativeStrengthScore(stockReturn, sector?.benchmarkReturnPct, config);

  const rawScore = trendScore + volumePrice.score + fromLow.score + volatilityTrend + relativeStrength.score;
  const totalScore = round(rawScore * SCORE_SCALE / RAW_SCORE_MAX, 1);

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
    relative_strength_score: relativeStrength.score,
    relative_strength_label: relativeStrength.label,
    relative_strength_pct: relativeStrength.excessPct,
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

/**
 * 排行榜排序比较器：总分降序，并列时用**连续量**破平局。
 *
 * 四个维度几乎全是离散档位（28/14/0、22/20/18…），total_score 的取值集合很小、并列极多。
 * 过去所有排序点都直接 `stock_code.localeCompare` 破平局，于是并列组内系统性偏向代码小的
 * 股票（000xxx / 600xxx）—— top-N 选股因此混入了与因子完全无关的代码序偏差。
 * 改用 trend_strength（连续浮点）作次键可破掉绝大多数并列；stock_code 仅作最终兜底以保证确定性。
 */
export function compareByScore(left: RankingRow, right: RankingRow): number {
  const scoreDiff = Number(right.total_score ?? 0) - Number(left.total_score ?? 0);
  if (scoreDiff) return scoreDiff;
  const strengthDiff = Number(right.trend_strength ?? 0) - Number(left.trend_strength ?? 0);
  if (strengthDiff) return strengthDiff;
  return String(left.stock_code ?? '').localeCompare(String(right.stock_code ?? ''));
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
  /**
   * 多周期交叉验证把日线分类改写得**更保守**时为 true。
   * 升级（更乐观）不会置位——要判断"是否被改写过"请读 `adjusted`。
   */
  downgraded?: boolean;
  /** 多周期交叉验证是否改写过日线分类（升级、降级都为 true）。 */
  adjusted?: boolean;
  /** 改写方向：'down' = 降级（更保守），'up' = 升级（更乐观）。 */
  adjust_direction?: 'up' | 'down';
  /** 日线原始分类的 state_id；analyzeBlockTrend 在降级/升级时保留以供审计。 */
  original_state_id?: number;
  original_state_name?: string;
  /** 周/月线是否参与了本次判定；未参与时该状态仅由日线得出，可信度较低。 */
  confirmations?: { weekly: boolean; monthly: boolean };
  /** 周/月线各自的粗趋势；供 blockStrategy 做共振/背离修正。 */
  higher_timeframe?: { weekly: TrendAxis; monthly: TrendAxis };
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
  8: { state_id: 8, state_name: '筑底成功', trend: '横盘', position: '1成', signal: 'buy' },
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


/**
 * 底部反转确认项，用于区分「筑底成功」与「下跌中继反抽」。
 *
 * state 8 按设计就发生在均线仍空头排列的结构里，所以不能简单地用 `!falling` 排除；
 * 真正的分水岭是**方向是否已经转折**。四项证据分成两类：
 *
 * - 动量类（`momentum`）：收盘站上 5 日线、-DI 不再压倒性领先。
 *   这两项**一根长阳就能满足** —— 实测持续阴跌中插一根 +8.5% 的假反弹即可同时点亮两项。
 * - 结构类（`structural`）：5 日线掉头向上、低点抬高（最近 5 日最低 > 前 10 日最低）。
 *   这两项需要连续多根 K 线的形态配合，单根脉冲伪造不出来。
 *
 * 因此判定要求「总数达标 **且** 至少一项结构证据」，否则动量类会把暴力反抽放进来。
 */
function bottomingConfirmations(bars: Bar[], endIndex: number, adx: AdxResult): {
  total: number;
  structural: number;
} {
  const close = bars[endIndex].close;
  const ma5 = movingAverage(bars, endIndex, 5);
  const ma5Earlier = endIndex >= 5 ? movingAverage(bars, endIndex - 5, 5) : null;
  let momentum = 0;
  let structural = 0;
  if (ma5 != null && close > ma5) momentum += 1;
  if (adx.direction > -10) momentum += 1;
  if (ma5 != null && ma5Earlier != null && ma5 > ma5Earlier) structural += 1;
  if (endIndex >= 14) {
    const recentLow = Math.min(...bars.slice(endIndex - 4, endIndex + 1).map((bar) => bar.low));
    const priorLow = Math.min(...bars.slice(endIndex - 14, endIndex - 4).map((bar) => bar.low));
    if (recentLow > priorLow) structural += 1;
  }
  return { total: momentum + structural, structural };
}

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
  // ADX 未完成预热（样本 < period*2）时它不构成否决条件，退回纯斜率判断 ——
  // 否则数据刚够 20 根的板块会被系统性地全部压成震荡市。
  const adxUsable = adx.warm;
  const adxTrending = adx.adx >= thresholds.adxTrending;
  const adxBullish = adx.direction > thresholds.adxDirectionDeadZone;
  const adxBearish = adx.direction < -thresholds.adxDirectionDeadZone;
  const rising = alignment === 'bullish'
    || (strength > thresholds.risingStrength && (!adxUsable || (adxTrending && adxBullish)));
  const falling = alignment === 'bearish'
    || (strength < thresholds.fallingStrength && (!adxUsable || (adxTrending && adxBearish)));

  const bottomingEvidence = bottomingConfirmations(bars, endIndex, adx);
  const bottomingSuccess = !rising
    && return5 >= thresholds.bottomingMinReturn5
    && return5 <= thresholds.bottomingMaxReturn5
    && volumeRatio >= thresholds.heavyVolumeRatio
    && distanceFromHigh <= thresholds.bottomingMinDistanceFromHigh
    && strength > -0.005
    // 放量反弹本身既可能是筑底，也可能是下跌中继反抽；要求结构性转折确认。
    && bottomingEvidence.total >= thresholds.bottomingMinConfirmations
    && bottomingEvidence.structural >= 1;

  if (bottomingSuccess) {
    return buildStateResult(8, bars, { adx: adx.adx, plus_di: adx.plusDI, minus_di: adx.minusDI });
  }

  let stateId: number;
  if (rising && !falling) {
    // 上升趋势下一律做量能检验：距高点 -5%~-3% 的中间带过去直接判 1（主线主升），
    // 导致「距高点 -2% 缩量 → state 2 卖出」而「-4% 缩量 → state 1 七九成买入」
    // 这种仅 2% 位置差就翻转信号的悬崖。现在中间带与近高点用同一套量能标准。
    const healthyVolume = volumeRatio >= thresholds.risingVolumeRatio;
    if (distanceFromHigh > thresholds.nearHighDistance) {
      stateId = healthyVolume ? 1 : 2;
    } else if (distanceFromHigh <= thresholds.pullbackDistance) {
      stateId = 3;
    } else {
      stateId = healthyVolume ? 1 : 2;
    }
  } else if (falling && !rising) {
    stateId = (return5 <= thresholds.panicReturn5 || volatility >= thresholds.panicVolatility) ? 7 : 6;
  } else {
    stateId = volumeRatio < thresholds.dryVolumeRatio ? 5 : 4;
  }
  return buildStateResult(stateId, bars, { adx: adx.adx, plus_di: adx.plusDI, minus_di: adx.minusDI });
}

/**
 * 周/月线粗判断：ADX 方向 + 斜率共振 → up / down / range。
 *
 * 需要 `MIN_HIGHER_TIMEFRAME_BARS` 根才判方向：过去只要 14 根就判，而 14 根恰好
 * 让 computeADX 返回 adx=0（endIndex < period）永远得到 range，15~27 根则输出未预热的
 * 噪音值 —— 门槛形同虚设却又不可信。样本不足时返回 range（无共振），不猜方向。
 */
export function singlePeriodTrend(
  bars: Bar[],
  thresholds: MarketStateThresholds = DEFAULT_MARKET_STATE_THRESHOLDS,
): TrendAxis {
  if (bars.length < MIN_HIGHER_TIMEFRAME_BARS) return 'range';
  const endIndex = bars.length - 1;
  const strength = trendStrength(bars, endIndex, Math.min(bars.length, 12));
  const adx = computeADX(bars, endIndex, 14);
  if (!adx.warm || adx.adx < thresholds.higherTimeframeAdxMin) return 'range'; // ADX 不可信或太低，方向不作数
  const slopeUp = strength > thresholds.risingStrength || adx.direction > thresholds.adxDirectionDeadZone;
  const slopeDown = strength < thresholds.fallingStrength || adx.direction < -thresholds.adxDirectionDeadZone;
  if (slopeUp && !slopeDown) return 'up';
  if (slopeDown && !slopeUp) return 'down';
  return 'range';
}

/**
 * 板块趋势分析：日线八态分类 + 周/月线交叉验证。
 *
 * 多周期共振规则（周月线长度足够时生效）：
 * 1. 日线上升 + 周月均下跌 → 降级为「阴跌不止」（日线反弹 trap）。
 * 2. 日线 state 8（筑底成功） + 周月均下跌 → 抑制为「阴跌不止」（假底部）。
 * 3. 日线下跌 + 周月均上升 → 升级为「筑底成功」（多周期底部共振）。
 * 4. 其他情况保留日线分类。
 *
 * 无论是否改写，都会输出 `confirmations` 标明周/月线是否真的参与了判定 ——
 * 仅由日线得出的状态可信度较低，下游（sector_trend_daily / blockStrategy）可据此降权。
 */
export function analyzeBlockTrend(
  daily: Bar[],
  weekly?: Bar[],
  monthly?: Bar[],
  thresholds: MarketStateThresholds = DEFAULT_MARKET_STATE_THRESHOLDS,
): MarketStateResult {
  const state = classifyMarketState(daily, thresholds);
  const hasWeekly = (weekly?.length ?? 0) >= MIN_HIGHER_TIMEFRAME_BARS;
  const hasMonthly = (monthly?.length ?? 0) >= MIN_HIGHER_TIMEFRAME_BARS;
  const confirmations = { weekly: hasWeekly, monthly: hasMonthly };
  if (!hasWeekly || !hasMonthly) return { ...state, confirmations };

  const weeklyTrend = singlePeriodTrend(weekly!, thresholds);
  const monthlyTrend = singlePeriodTrend(monthly!, thresholds);
  const bothDown = weeklyTrend === 'down' && monthlyTrend === 'down';
  const bothUp = weeklyTrend === 'up' && monthlyTrend === 'up';

  /** 保留日线原始分类以供审计；direction 区分降级与升级。 */
  const rewrite = (templateId: number, direction: 'up' | 'down'): MarketStateResult => buildStateResult(templateId, daily, {
    adjusted: true,
    adjust_direction: direction,
    downgraded: direction === 'down',
    original_state_id: state.state_id,
    original_state_name: state.state_name,
    adx: state.adx,
    plus_di: state.plus_di,
    minus_di: state.minus_di,
    confirmations,
    higher_timeframe: { weekly: weeklyTrend, monthly: monthlyTrend },
  });

  // 1. 日线上升 + 周月均下跌 → 降级为「阴跌不止」。
  if (state.trend === '上升' && bothDown) return rewrite(6, 'down');

  // 2. 日线 state 8（筑底成功） + 周月均下跌 → 抑制为「阴跌不止」。
  if (state.state_id === 8 && bothDown) return rewrite(6, 'down');

  // 3. 日线下跌 + 周月均上升 → 升级为「筑底成功」（多周期底部共振）。
  if (state.trend === '下跌' && bothUp) return rewrite(8, 'up');

  return { ...state, confirmations, higher_timeframe: { weekly: weeklyTrend, monthly: monthlyTrend } };
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

export interface BlockStrategyContext {
  /**
   * 全市场涨停总数。用于把「板块热度」相对化 —— 冷市场（全市场 30 家涨停）里单板块
   * 5 家已是绝对主线，热市场（120 家）里 5 家很普通，用同一个绝对阈值判热度是失真的。
   * 缺省时退回固定阈值 5，保持旧行为。
   */
  marketLimitUpTotal?: number;
  /** 周/月线粗趋势，用于正向共振加档（负向背离已由 analyzeBlockTrend 降级处理）。 */
  higherTimeframe?: { weekly: TrendAxis; monthly: TrendAxis };
}

/** 仓位档位由轻到重；共振修正在这个梯子上移动一格。 */
const POSITION_LADDER = ['0成', '0-1成', '1成', '0-3成', '3-5成', '7-9成'] as const;

function shiftPosition(position: string, notches: number): string {
  const index = POSITION_LADDER.indexOf(position as typeof POSITION_LADDER[number]);
  if (index < 0) return position;
  return POSITION_LADDER[Math.min(POSITION_LADDER.length - 1, Math.max(0, index + notches))];
}

/**
 * 板块热度判定：涨停家数达标 + 连板高度 >= 2。
 *
 * 达标线随市场温度缩放（全市场涨停总数的 12%，钳制在 3~8 家），而不是固定 5 家。
 */
export function isHotBlock(limitUpNum: number, maxContinue: number, marketLimitUpTotal?: number): boolean {
  const required = marketLimitUpTotal != null && marketLimitUpTotal > 0
    ? Math.min(8, Math.max(3, Math.round(marketLimitUpTotal * 0.12)))
    : 5;
  return limitUpNum >= required && maxContinue >= 2;
}

/**
 * 状态 × 涨停热度 → 板块策略。
 *
 * 多周期正向共振（周月线同时向上）会把仓位上调一档：过去 analyzeBlockTrend 的交叉验证
 * 只做负向（降级）与极端底部（升级），「日线主升 + 周月共振」与「日线主升 + 周月震荡」
 * 完全同分同策略，正向的多周期信息被浪费。负向不在这里再减一档 —— 那已经由
 * analyzeBlockTrend 改写 state_id 处理过，重复扣会把同一个信号计两次。
 */
export function blockStrategy(
  stateId: number,
  limitUpNum: number,
  maxContinue: number,
  context: BlockStrategyContext = {},
): BlockStrategy {
  const hot = isHotBlock(limitUpNum, maxContinue, context.marketLimitUpTotal);
  const base = ((): BlockStrategy => {
    switch (stateId) {
      case 1: return hot ? strategyFor('主线主升', '7-9成') : strategyFor('趋势跟踪', '3-5成');
      case 2: return strategyFor('逢高减仓', '3-5成');
      case 3: return strategyFor('博反抽', '3-5成');
      case 4: return hot ? strategyFor('情绪博弈', '3-5成') : strategyFor('箱体操作', '0-3成');
      case 5: return strategyFor('休息', '0成');
      case 6: return strategyFor('回避', '0成');
      case 7: return hot ? strategyFor('超跌反弹', '0-1成') : strategyFor('回避', '0成');
      case 8: return strategyFor('筑底成功', '1成');
      default: return strategyFor('回避', '0成');
    }
  })();

  const higher = context.higherTimeframe;
  const bothUp = higher?.weekly === 'up' && higher?.monthly === 'up';
  if (bothUp && base.action !== 'ignore') {
    return { ...base, position: shiftPosition(base.position, 1) };
  }
  return base;
}
