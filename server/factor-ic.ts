import type { RankingRow } from '../src/types.js';
import { computeBacktestScores } from './backtest-scoring.js';
import { round } from './format.js';
import { normalizeBacktestDays, type HistoricalMarketData } from './historical-market.js';
import {
  DEFAULT_SCORE_STOCK_CONFIG,
  DIMENSION_MAX,
  type ScoreStockConfig,
} from './scoring-engine.js';

// ---------------------------------------------------------------------------
// 因子有效性评估：RankIC / ICIR / 分层收益 / 因子间相关性。
//
// 在此之前，因子权重完全靠 backtest-param-optimizer 的暴力网格搜索决定 —— 没有任何
// 证据说明某个维度是否真的预测了未来收益。网格搜索在几十个交易日上找「收益最高的权重」
// 极易过拟合：它优化的是这段样本的路径，而不是因子的预测能力。
//
// 这里提供的是与回测收益**正交**的证据：
//   - RankIC：当日截面上「因子值排名」与「未来 N 日收益排名」的 Spearman 相关系数。
//     每日一个值，取时序均值。|IC| > 0.03 通常即有意义，> 0.05 算强。
//   - ICIR = mean(IC) / std(IC)：稳定性。IC 均值高但忽正忽负的因子不可用。
//   - t 统计量 = ICIR × sqrt(天数)：|t| > 2 才算显著。
//   - 分层收益：按因子值分 5 档，看未来收益是否单调。不单调说明关系非线性或是噪音。
//   - 因子相关矩阵：识别重复计算。例如板块趋势同时驱动维度 1 的板块加分与维度 4 的
//     趋势轴，两者相关性会很高 —— 那是同一个信号被计了两次，不是两个独立因子。
// ---------------------------------------------------------------------------

/** 参与评估的因子维度。key 必须是 RankingRow 上的数值字段。 */
export const IC_FACTORS = [
  { key: 'trend_score', label: 'K线趋势', max: DIMENSION_MAX.trend },
  { key: 'volume_price_score', label: '价量配合', max: DIMENSION_MAX.volumePrice },
  { key: 'position_score', label: '距60日低点', max: DIMENSION_MAX.distanceFromLow },
  { key: 'volatility_trend_score', label: '波动率-趋势', max: DIMENSION_MAX.volatilityTrend },
  { key: 'relative_strength_score', label: '相对强度', max: DIMENSION_MAX.relativeStrength },
  { key: 'total_score', label: '总分', max: 100 },
] as const;

export interface FactorICResult {
  key: string;
  label: string;
  /** 时序平均 RankIC。 */
  meanIC: number;
  /** RankIC 的时序标准差。 */
  stdIC: number;
  /** ICIR = meanIC / stdIC，衡量稳定性。 */
  icir: number;
  /** t = ICIR × sqrt(N)，|t| > 2 视为显著。 */
  tStat: number;
  /** IC > 0 的交易日占比（%）。 */
  positiveRatio: number;
  /** 有效交易日数量。 */
  sampleDays: number;
  /** 五档分层的未来平均收益（%），下标 0 = 因子值最低档。 */
  quintileReturns: number[];
  /** 分层收益是否随因子值单调上升。 */
  monotone: boolean;
}

export interface FactorICReport {
  days: number;
  forwardDays: number;
  dateRange: string;
  factors: FactorICResult[];
  /** 因子两两之间的截面相关系数（Spearman，全样本平均）。 */
  correlations: Array<{ a: string; b: string; correlation: number }>;
  notes: string[];
}

/** 升序排名，并列取平均名次（Spearman 要求）。 */
function rankValues(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1].value === order[position].value) end += 1;
    const averageRank = (position + end) / 2 + 1;
    for (let index = position; index <= end; index += 1) ranks[order[index].index] = averageRank;
    position = end + 1;
  }
  return ranks;
}

function pearson(left: number[], right: number[]): number {
  const n = left.length;
  if (n < 3) return 0;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < n; index += 1) {
    const dl = left[index] - meanLeft;
    const dr = right[index] - meanRight;
    covariance += dl * dr;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
  }
  const denominator = Math.sqrt(varianceLeft * varianceRight);
  return denominator > 0 ? covariance / denominator : 0;
}

/** Spearman 秩相关。 */
export function spearman(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 3) return 0;
  return pearson(rankValues(left), rankValues(right));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** 按 date → code → close 建立收盘价索引，用于计算未来收益。 */
function closesByDate(history: HistoricalMarketData): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const stock of history.stocks) {
    for (const bar of stock.bars) {
      const date = String(bar[0]).replaceAll('-', '').slice(0, 8);
      const close = Number(bar[2]);
      if (!(close > 0)) continue;
      const byCode = result.get(date) ?? new Map<string, number>();
      byCode.set(stock.stock_code, close);
      result.set(date, byCode);
    }
  }
  return result;
}

/** 把样本按因子值分成 buckets 档，返回每档的未来平均收益。 */
function quintileReturns(pairs: Array<{ factor: number; forward: number }>, buckets = 5): number[] {
  if (pairs.length < buckets) return new Array(buckets).fill(0);
  const sorted = [...pairs].sort((left, right) => left.factor - right.factor);
  const result: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * sorted.length / buckets);
    const end = Math.floor((bucket + 1) * sorted.length / buckets);
    const slice = sorted.slice(start, end);
    result.push(slice.length
      ? round(slice.reduce((sum, item) => sum + item.forward, 0) / slice.length, 3)
      : 0);
  }
  return result;
}

/**
 * 计算因子 IC 报告。
 *
 * 未来收益口径为「信号日收盘 → forwardDays 个交易日后收盘」。回测实际是次日开盘成交，
 * 两者会有一天的错位，但 IC 衡量的是**因子的排序能力**而非可实现收益，收盘对收盘是标准做法。
 */
export function computeFactorIC(
  history: HistoricalMarketData,
  days = 60,
  forwardDays = 5,
  scoringConfig: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): FactorICReport {
  const normalizedDays = normalizeBacktestDays(days);
  const calendar = history.calendar.filter((date) => date <= history.as_of_date);
  const dates = calendar.slice(-normalizedDays);
  if (dates.length < forwardDays + 2) {
    throw new Error(`历史区间不足，至少需要 ${forwardDays + 2} 个交易日才能计算 IC`);
  }
  const limitUpDates = new Map<string, Set<string>>();
  for (const record of history.limit_up_records ?? []) {
    const date = record.date.replaceAll('-', '').slice(0, 8);
    const set = limitUpDates.get(record.stock_code) ?? new Set<string>();
    set.add(date);
    limitUpDates.set(record.stock_code, set);
  }
  const scoreMap = computeBacktestScores(history, dates, limitUpDates, scoringConfig);
  const priceIndex = closesByDate(history);
  const calendarIndex = new Map(calendar.map((date, index) => [date, index]));

  // 每个因子：逐日 IC 序列 + 全样本 (因子值, 未来收益) 对
  const icSeries = new Map<string, number[]>();
  const samples = new Map<string, Array<{ factor: number; forward: number }>>();
  for (const factor of IC_FACTORS) {
    icSeries.set(factor.key, []);
    samples.set(factor.key, []);
  }
  // 因子间相关性：逐日截面相关，最后取平均
  const correlationSeries = new Map<string, number[]>();

  let evaluatedDays = 0;
  for (const date of dates) {
    const rows = scoreMap.get(date) ?? [];
    if (rows.length < 5) continue;
    const signalIndex = calendarIndex.get(date);
    if (signalIndex == null) continue;
    const exitDate = calendar[signalIndex + forwardDays];
    if (!exitDate) continue;
    const entryCloses = priceIndex.get(date);
    const exitCloses = priceIndex.get(exitDate);
    if (!entryCloses || !exitCloses) continue;

    // 只保留两端都有价格的样本，保证每个因子面对同一批股票。
    const usable: Array<{ row: RankingRow; forward: number }> = [];
    for (const row of rows) {
      const entry = entryCloses.get(row.stock_code);
      const exit = exitCloses.get(row.stock_code);
      if (entry == null || exit == null || !(entry > 0) || !(exit > 0)) continue;
      usable.push({ row, forward: (exit - entry) / entry * 100 });
    }
    if (usable.length < 5) continue;
    evaluatedDays += 1;
    const forwards = usable.map((item) => item.forward);

    const factorVectors = new Map<string, number[]>();
    for (const factor of IC_FACTORS) {
      const values = usable.map((item) => Number(item.row[factor.key] ?? 0));
      factorVectors.set(factor.key, values);
      icSeries.get(factor.key)!.push(spearman(values, forwards));
      const bucket = samples.get(factor.key)!;
      for (let index = 0; index < values.length; index += 1) {
        bucket.push({ factor: values[index], forward: forwards[index] });
      }
    }
    // 因子两两相关（跳过 total_score，它是其余各维的线性组合）
    const pairKeys = IC_FACTORS.filter((factor) => factor.key !== 'total_score');
    for (let i = 0; i < pairKeys.length; i += 1) {
      for (let j = i + 1; j < pairKeys.length; j += 1) {
        const key = `${pairKeys[i].key}|${pairKeys[j].key}`;
        const list = correlationSeries.get(key) ?? [];
        list.push(spearman(factorVectors.get(pairKeys[i].key)!, factorVectors.get(pairKeys[j].key)!));
        correlationSeries.set(key, list);
      }
    }
  }

  const factors: FactorICResult[] = IC_FACTORS.map((factor) => {
    const series = icSeries.get(factor.key)!;
    const meanIC = series.length ? series.reduce((sum, value) => sum + value, 0) / series.length : 0;
    const stdIC = standardDeviation(series);
    const icir = stdIC > 0 ? meanIC / stdIC : 0;
    const buckets = quintileReturns(samples.get(factor.key)!);
    let monotone = true;
    for (let index = 1; index < buckets.length; index += 1) {
      if (buckets[index] < buckets[index - 1]) { monotone = false; break; }
    }
    return {
      key: factor.key,
      label: factor.label,
      meanIC: round(meanIC, 4),
      stdIC: round(stdIC, 4),
      icir: round(icir, 3),
      tStat: round(icir * Math.sqrt(Math.max(1, series.length)), 2),
      positiveRatio: series.length
        ? round(series.filter((value) => value > 0).length / series.length * 100, 1)
        : 0,
      sampleDays: series.length,
      quintileReturns: buckets,
      monotone,
    };
  });

  const correlations = [...correlationSeries.entries()].map(([key, values]) => {
    const [a, b] = key.split('|');
    return {
      a,
      b,
      correlation: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), 3),
    };
  }).sort((left, right) => Math.abs(right.correlation) - Math.abs(left.correlation));

  const notes = [
    `未来收益口径：信号日收盘 → ${forwardDays} 个交易日后收盘（回测实际次日开盘成交，存在 1 日错位）`,
    '|meanIC| > 0.03 视为有效，> 0.05 视为强；|tStat| > 2 视为显著',
    'monotone=false 表示分层收益不单调，该维度与未来收益的关系可能是非线性或纯噪音',
    '因子相关性 > 0.7 提示两个维度在重复计入同一信号',
  ];
  if (evaluatedDays < 20) {
    notes.push(`仅 ${evaluatedDays} 个有效交易日，IC 估计的置信度很低，建议拉长区间`);
  }

  return {
    days: normalizedDays,
    forwardDays,
    dateRange: `${dates[0]} ~ ${dates.at(-1)}`,
    factors,
    correlations,
    notes,
  };
}
