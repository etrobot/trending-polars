/**
 * 统一指标计算模块（P1）。
 *
 * 回测、参数优化、模拟交易三条路径共用这一套指标口径，避免各自实现导致漂移。
 *
 * 口径约定（改动前请先读这里）：
 * - 年化收益：按自然日跨度折算（365.25 天/年），使用复利公式 (期末/期初)^(1/年数) - 1。
 * - 最大回撤：净值曲线上的最大峰谷跌幅，输出为**负数百分比**（如 -12.34 表示回撤 12.34%）。
 * - 夏普比率：日频收益序列，均值/标准差年化，**年化系数固定 252**；
 *   无风险利率按年化传入，内部折算为日频（(1+rf)^(1/252)-1）。
 * - 胜率：已平仓交易（卖出）中盈亏为正的比例，输出百分比（0-100）。
 * - 盈亏比：总盈利 / 总亏损（亏损取绝对值）；无亏损时用 999 近似无穷，避免 JSON 出现 null。
 * - 交易次数：**已平仓交易笔数**（卖出成交数），不是买卖成交总笔数。
 * - 换手率：区间内全部成交金额 / 初始资金，单位为「倍」。
 *
 * 净值曲线来源优先级：
 * 1. 传入 equityCurve 时直接使用（回测/模拟交易用逐日盯市或账户快照）。
 * 2. 未传入时由成交记录推导：以「初始资金 + 累计已实现盈亏」为净值阶梯曲线。
 */

import { round } from '../format.js';

/** 日频年化系数，所有日频指标统一使用，避免各路径各自定义。 */
export const TRADING_DAYS_PER_YEAR = 252;
/** 自然日年化天数。 */
export const CALENDAR_DAYS_PER_YEAR = 365.25;
/** 统计意义约束：低于该交易次数的组合标记 insufficient。 */
export const DEFAULT_MIN_TRADE_COUNT = 20;
/** 无亏损时盈亏比的近似上限（JSON 友好）。 */
const PROFIT_FACTOR_CAP = 999;

export interface PerformanceTrade {
  /** 成交日期，YYYYMMDD。 */
  date: string;
  side: 'buy' | 'sell';
  price: number;
  shares: number;
  /** 成交金额，不含费用。 */
  amount: number;
  /** 手续费 + 税费合计。 */
  fee?: number;
  /** 已实现盈亏净额（卖出成交才有，不含费用）。 */
  pnlAmount?: number;
}

export interface EquityPoint {
  date: string;
  total: number;
}

export interface PerformanceMetrics {
  /** 年化收益率（%）。 */
  annualReturn: number;
  /** 最大回撤（%，负数）。 */
  maxDrawdown: number;
  /** 夏普比率（日频年化，系数 252）。 */
  sharpe: number;
  /** 胜率（%，0-100）。 */
  winRate: number;
  /** 盈亏比。 */
  profitFactor: number;
  /** 已平仓交易笔数。 */
  tradeCount: number;
  /** 换手率（倍）。 */
  turnover: number;
}

export interface MetricsInput {
  trades: PerformanceTrade[];
  /** 可选的逐日净值曲线；不传则由成交记录推导。 */
  equityCurve?: EquityPoint[];
  /** 初始资金，用于换手率与已实现盈亏曲线的基线。 */
  initialCapital?: number;
  /** 年化无风险利率，默认 0。 */
  riskFreeRate?: number;
}

export interface DateRange {
  /** YYYYMMDD。 */
  start: string;
  /** YYYYMMDD。 */
  end: string;
}

export interface SampleSplit {
  inSample: DateRange;
  outOfSample: DateRange;
}

export interface PerformanceEvaluation {
  metrics: PerformanceMetrics;
  /** 交易次数是否低于统计意义门槛。 */
  insufficient: boolean;
  /** 实际使用的门槛值。 */
  minTradeCount: number;
}

function sortTrades(trades: PerformanceTrade[]): PerformanceTrade[] {
  return [...trades].sort((left, right) => {
    if (left.date !== right.date) return left.date.localeCompare(right.date);
    if (left.side !== right.side) return left.side === 'buy' ? -1 : 1;
    return 0;
  });
}

/** 由成交记录推导阶梯净值曲线：初始资金 + 累计已实现盈亏。 */
export function deriveEquityCurve(
  trades: PerformanceTrade[],
  initialCapital = 0,
): EquityPoint[] {
  const sorted = sortTrades(trades);
  const points: EquityPoint[] = [];
  let realized = 0;
  let lastDate = '';
  for (const trade of sorted) {
    if (trade.side === 'sell' && Number.isFinite(trade.pnlAmount)) {
      realized += Number(trade.pnlAmount);
    }
    if (trade.date !== lastDate) {
      points.push({ date: trade.date, total: round(initialCapital + realized, 6) });
      lastDate = trade.date;
    } else if (points.length) {
      points[points.length - 1] = { date: trade.date, total: round(initialCapital + realized, 6) };
    }
  }
  return points;
}

function normalizeEquityCurve(points: EquityPoint[]): EquityPoint[] {
  return [...points]
    .filter((point) => Number.isFinite(point.total))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function dailyReturns(points: EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].total;
    const current = points[index].total;
    if (previous > 0) returns.push(current / previous - 1);
  }
  return returns;
}

function spanYears(points: EquityPoint[]): number {
  if (points.length < 2) return 0;
  const start = Date.parse(`${points[0].date.slice(0, 4)}-${points[0].date.slice(4, 6)}-${points[0].date.slice(6, 8)}T00:00:00Z`);
  const end = Date.parse(`${points.at(-1)!.date.slice(0, 4)}-${points.at(-1)!.date.slice(4, 6)}-${points.at(-1)!.date.slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / (24 * 60 * 60 * 1000) / CALENDAR_DAYS_PER_YEAR;
}

function maxDrawdownPercent(points: EquityPoint[]): number {
  let peak = points[0]?.total ?? 0;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.total);
    if (peak > 0) worst = Math.min(worst, (point.total - peak) / peak);
  }
  return round(worst * 100, 2);
}

function sharpeRatio(points: EquityPoint[], annualRiskFreeRate: number): number {
  const returns = dailyReturns(points);
  if (returns.length < 2) return 0;
  const dailyRiskFree = (1 + annualRiskFreeRate) ** (1 / TRADING_DAYS_PER_YEAR) - 1;
  const excess = returns.map((value) => value - dailyRiskFree);
  const mean = excess.reduce((sum, value) => sum + value, 0) / excess.length;
  const variance = excess.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (excess.length - 1);
  const std = Math.sqrt(variance);
  if (std <= 0) return 0;
  return round((mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR), 4);
}

/**
 * 统一指标计算入口。三条路径都必须走这里。
 */
export function computeMetrics(input: MetricsInput): PerformanceMetrics {
  const trades = sortTrades(input.trades ?? []);
  const initialCapital = Number(input.initialCapital ?? 0);
  const points = input.equityCurve?.length
    ? normalizeEquityCurve(input.equityCurve)
    : deriveEquityCurve(trades, initialCapital);

  const closedTrades = trades.filter((trade) => trade.side === 'sell' && Number.isFinite(trade.pnlAmount));
  const wins = closedTrades.filter((trade) => Number(trade.pnlAmount) > 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnlAmount), 0);
  const grossLoss = closedTrades
    .filter((trade) => Number(trade.pnlAmount) < 0)
    .reduce((sum, trade) => sum + Math.abs(Number(trade.pnlAmount)), 0);
  const totalAmount = trades.reduce((sum, trade) => sum + Number(trade.amount ?? 0), 0);

  const first = points[0]?.total ?? initialCapital;
  const last = points.at(-1)?.total ?? first;
  const years = spanYears(points);
  const annualReturn = years > 0 && first > 0 && last > 0
    ? round(((last / first) ** (1 / years) - 1) * 100, 2)
    : 0;

  return {
    annualReturn,
    maxDrawdown: maxDrawdownPercent(points),
    sharpe: sharpeRatio(points, Number(input.riskFreeRate ?? 0)),
    winRate: closedTrades.length ? round(wins.length / closedTrades.length * 100, 1) : 0,
    profitFactor: grossLoss > 0
      ? round(grossProfit / grossLoss, 4)
      : grossProfit > 0 ? PROFIT_FACTOR_CAP : 0,
    tradeCount: closedTrades.length,
    turnover: initialCapital > 0 ? round(totalAmount / initialCapital, 4) : 0,
  };
}

/**
 * 计算指标并给出统计意义判定。
 */
export function evaluatePerformance(
  input: MetricsInput,
  minTradeCount = DEFAULT_MIN_TRADE_COUNT,
): PerformanceEvaluation {
  const metrics = computeMetrics(input);
  return {
    metrics,
    insufficient: metrics.tradeCount < minTradeCount,
    minTradeCount,
  };
}

/**
 * 按时间轴切分样本内/样本外。
 *
 * @param range 待切分的日期区间
 * @param calendar 交易日历（YYYYMMDD），用于按交易日数量精确切分
 * @param inRatio 样本内占比，默认 0.7
 */
export function splitSample(
  range: DateRange,
  calendar: readonly string[],
  inRatio = 0.7,
): SampleSplit {
  const days = calendar.filter((date) => date >= range.start && date <= range.end);
  if (!days.length) {
    return { inSample: { ...range }, outOfSample: { ...range } };
  }
  const ratio = Math.min(0.99, Math.max(0.01, inRatio));
  const inCount = Math.min(days.length - 1 || 1, Math.max(1, Math.floor(days.length * ratio)));
  const inSample: DateRange = { start: days[0], end: days[inCount - 1] };
  const outOfSample: DateRange = { start: days[inCount] ?? days.at(-1)!, end: days.at(-1)! };
  return { inSample, outOfSample };
}

/** 判断某个日期是否落在区间内（闭区间）。 */
export function isWithinRange(date: string, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

/** 过滤出落在区间内的成交记录。 */
export function filterTradesByRange(
  trades: PerformanceTrade[],
  range: DateRange,
): PerformanceTrade[] {
  return trades.filter((trade) => isWithinRange(trade.date, range));
}

/** 过滤出落在区间内的净值曲线。 */
export function filterEquityByRange(
  points: EquityPoint[],
  range: DateRange,
): EquityPoint[] {
  return points.filter((point) => isWithinRange(point.date, range));
}
