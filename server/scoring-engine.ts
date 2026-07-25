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

export function volatilityClassOf(limitUpCount20d: number): VolatilityClass {
  if (limitUpCount20d >= 3) return 'high';
  if (limitUpCount20d >= 1) return 'medium';
  return 'low';
}

// 交叉评分矩阵（ref-doc §4.2 维度 4）：行＝波动率，列＝板块趋势。
const VOLATILITY_TREND_MATRIX: Record<VolatilityClass, Record<TrendAxis, number>> = {
  high: { up: 15, range: 8, down: 1 },
  medium: { up: 12, range: 6, down: 3 },
  low: { up: 8, range: 4, down: 5 },
};

export function volatilityTrendScore(volatility: VolatilityClass, trend: TrendAxis): number {
  return VOLATILITY_TREND_MATRIX[volatility][trend];
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
export function distanceFromLowScore(distanceFromLowPct: number): DistanceFromLowScore {
  if (!Number.isFinite(distanceFromLowPct) || distanceFromLowPct < 0) {
    return { score: 2, label: '贴近低点' };
  }
  if (distanceFromLowPct < 5) return { score: 4, label: '贴近低点' };
  if (distanceFromLowPct < 15) return { score: 10, label: '刚离低点' };
  if (distanceFromLowPct < 30) return { score: 18, label: '启动确认' };
  if (distanceFromLowPct < 50) return { score: 20, label: '趋势上行' };
  if (distanceFromLowPct < 80) return { score: 14, label: '远离低点' };
  return { score: 8, label: '高位延伸' };
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
export function scoreStock(series: PreparedSeries, date: string, sector?: SectorContext): RankingRow | null {
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

  // 维度 1：K线趋势评分（均线排列基础分 + 趋势强度加分 + 板块上升加分）
  const alignmentScore = alignment === 'bullish' ? 28 : alignment === 'bearish' ? 0 : 14;
  const trendBonus = strength > 0.003
    ? Math.min(12, strength * 400)
    : strength < -0.003
      ? Math.max(-12, strength * 400)
      : 0;
  const sectorBonus = sector?.trend === 'up' ? 4 : sector?.trend === 'down' ? -4 : 0;
  const trendScore = Math.max(0, Math.min(40, alignmentScore + trendBonus + sectorBonus));

  // 维度 2：价量配合评分
  const volumePrice = volumePriceScore(series.bars, endIndex);

  // 维度 3：距60日低点评分
  const fromLow = distanceFromLowScore(distanceFromLowPct);

  // 维度 4：波动率-趋势适配评分
  const limitUps = limitUpCount(series.bars, endIndex, sector?.limitUpDates ?? new Set());
  const volatility = volatilityClassOf(limitUps);
  const trendAxis = sector?.trend ?? alignmentToTrendAxis(alignment);
  const volatilityTrend = volatilityTrendScore(volatility, trendAxis);

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
  downgraded?: boolean;
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

/**
 * 八种市场状态分类：均线排列 → 趋势强度 → 距高点 → 量能 → 波动率的规则判定。
 * 这是本地启发式实现（ref-doc 只给出状态表，未给出精确阈值）。
 */
export function classifyMarketState(bars: Bar[]): MarketStateResult {
  if (bars.length < 20) return buildStateResult(0, bars);
  const endIndex = bars.length - 1;
  const ma5 = movingAverage(bars, endIndex, 5);
  const ma10 = movingAverage(bars, endIndex, 10);
  const ma20 = movingAverage(bars, endIndex, 20);
  const ma60 = movingAverage(bars, endIndex, 60);
  const alignment = alignmentOf(ma5, ma10, ma20, ma60);
  const strength = trendStrength(bars, endIndex, 20);
  const close = bars[endIndex].close;
  const high60 = Math.max(...bars.slice(Math.max(0, endIndex - 59), endIndex + 1).map((bar) => bar.high));
  const distanceFromHigh = high60 > 0 ? (close - high60) / high60 : 0;
  const referenceClose = bars[Math.max(0, endIndex - 5)].close;
  const return5 = referenceClose > 0 ? (close - referenceClose) / referenceClose : 0;
  const volumeRatio = volumeTrendRatio(bars, endIndex);
  const volatility = standardDeviation(bars.slice(Math.max(0, endIndex - 19), endIndex + 1).map((bar) => bar.changePct));

  const rising = alignment === 'bullish' || strength > 0.003;
  const falling = alignment === 'bearish' || strength < -0.003;
  const bottomingSuccess = !rising
    && return5 > 0
    && return5 <= 0.08
    && volumeRatio >= 1.0
    && distanceFromHigh <= -0.08
    && strength > -0.005;

  if (bottomingSuccess) return buildStateResult(8, bars);

  let stateId: number;
  if (rising && !falling) {
    if (distanceFromHigh > -0.03) stateId = volumeRatio >= 0.9 ? 1 : 2;
    else if (distanceFromHigh <= -0.05) stateId = 3;
    else stateId = 1;
  } else if (falling && !rising) {
    if (return5 <= -0.08 || volatility >= 4.5) stateId = 7;
    else stateId = 6;
  } else {
    stateId = volumeRatio < 0.8 ? 5 : 4;
  }
  return buildStateResult(stateId, bars);
}

/** 周/月线粗判断：斜率方向 → up / down / range。 */
export function singlePeriodTrend(bars: Bar[]): TrendAxis {
  if (bars.length < 5) return 'range';
  const strength = trendStrength(bars, bars.length - 1, Math.min(bars.length, 12));
  if (strength > 0.005) return 'up';
  if (strength < -0.005) return 'down';
  return 'range';
}

/**
 * 板块趋势分析：日线七态分类 + 周/月线交叉验证。
 * 日线上升但周、月线均下跌 → 降级为「阴跌不止」（ref-doc §3.2）。
 */
export function analyzeBlockTrend(daily: Bar[], weekly?: Bar[], monthly?: Bar[]): MarketStateResult {
  const state = classifyMarketState(daily);
  if (state.trend === '上升' && weekly?.length && monthly?.length) {
    const weeklyTrend = singlePeriodTrend(weekly);
    const monthlyTrend = singlePeriodTrend(monthly);
    if (weeklyTrend === 'down' && monthlyTrend === 'down') {
      return buildStateResult(6, daily, { downgraded: true });
    }
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
