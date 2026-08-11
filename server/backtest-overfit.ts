/**
 * 过拟合分析。
 *
 * 给定一段历史行情 + 一组"当前方案"参数，把可用的 calendar 切成
 * 前/中/后三段窗口跑当前方案，计算跨窗口变异系数（CV）；再在最末
 * 窗口上跑 N 组随机参数组合，看当前方案在随机分布中的百分位。
 *
 * 目的：把"半年 230% 看起来像未来函数"这种怀疑落成可复核的数字。
 */
import type { BacktestResult, BacktestListItem } from '../src/types.js';
import type { HistoricalMarketData } from './historical-market.js';
import { runPolarsBacktest, runRandomizedBacktest, type FactorWeights } from './backtest-engine.js';
import type { ScoreStockConfig } from './scoring-engine.js';

export interface OverfitWindowResult {
  label: string;
  startIndex: number;
  days: number;
  date_range: string;
  total_return_pct: number;
  win_rate: number;
  max_drawdown_pct: number;
  total_trades: number;
  run_id: string;
}

export interface OverfitBucket {
  lower: number;
  upper: number;
  count: number;
  containsCurrent: boolean;
}

export interface OverfitAnalysisOptions {
  days: number;
  strategyCount: number;
  base: {
    maxHoldDays: number;
    maxPositions: number;
    positionSizePct: number;
    takeProfitPct: number;
    stopLossPct: number;
    trendWeightPct: number;
    volumePriceWeightPct: number;
    distanceFromLowWeightPct: number;
    volatilityTrendWeightPct: number;
    relativeStrengthWeightPct: number;
  };
  scoringConfig?: ScoreStockConfig;
  onProgress?: (stage: string, value: number, message: string) => void;
}

export interface OverfitAnalysisResult {
  base_run_id: string;
  base_summary: BacktestListItem;
  windows: OverfitWindowResult[];
  mean_return_pct: number;
  std_return_pct: number;
  cv: number;
  cv_flag: 'stable' | 'unstable';
  random_sample_size: number;
  random_min: number;
  random_max: number;
  random_percentiles: Record<'P25' | 'P50' | 'P75' | 'P90' | 'P99', number>;
  current_percentile: number;
  current_in_tail: boolean;
  buckets: OverfitBucket[];
  /** 回撤（drawdown）分析 */
  mean_drawdown_pct: number;
  std_drawdown_pct: number;
  drawdown_cv: number;
  drawdown_cv_flag: 'stable' | 'unstable';
  random_drawdown_min: number;
  random_drawdown_max: number;
  random_drawdown_percentiles: Record<'P25' | 'P50' | 'P75' | 'P90' | 'P99', number>;
  current_drawdown_percentile: number;
  current_drawdown_in_tail: boolean;
  drawdown_buckets: OverfitBucket[];
  verdict: 'ok' | 'warn_tail' | 'warn_unstable' | 'risk';
  verdict_summary: string;
  methodology: string;
  bias_notes: string[];
}

const WINDOW_BUCKETS = 10;
const STABLE_CV_THRESHOLD = 0.5;
const TAIL_PERCENTILE_THRESHOLD = 90;

function listSummary(result: BacktestResult): BacktestListItem {
  return {
    run_id: result.run_id,
    timestamp: result.timestamp,
    date_range: result.date_range,
    mode: result.config.mode as string | undefined,
    strategy_count: result.config.strategy_count as number | undefined,
    combo_index: result.config.combo_index as number | undefined,
    total_return_pct: result.summary.total_return_pct,
    win_rate: result.summary.win_rate,
    max_drawdown_pct: result.summary.max_drawdown_pct ?? 0,
    total_trades: result.summary.total_trades,
    max_holdings: result.summary.max_holdings,
    position_size_pct: result.config.position_size_pct as number | undefined,
    max_positions: result.config.max_positions as number | undefined,
    max_hold_days: result.config.max_hold_days as number | undefined,
  };
}

function sliceHistory(
  history: HistoricalMarketData,
  startIndex: number,
  days: number,
): HistoricalMarketData {
  const calendar = history.calendar;
  const end = Math.min(calendar.length, startIndex + days);
  const start = Math.max(0, startIndex);
  const slicedCal = calendar.slice(start, end);
  if (slicedCal.length < 5) {
    throw new Error(`窗口太短：只有 ${slicedCal.length} 个交易日，至少需要 5 个`);
  }
  const asOf = slicedCal[slicedCal.length - 1];
  const calSet = new Set(slicedCal);
  return {
    ...history,
    as_of_date: asOf,
    calendar: slicedCal,
    stocks: history.stocks.map((stock) => ({
      stock_code: stock.stock_code,
      stock_name: stock.stock_name,
      bars: stock.bars.filter((bar) => calSet.has(bar[0])),
    })),
    blocks: (history.blocks ?? []).map((block) => ({
      block_code: block.block_code,
      block_name: block.block_name,
      bars: block.bars.filter((bar) => calSet.has(bar[0])),
      weekly_bars: block.weekly_bars?.filter((bar) => bar[0].replaceAll('-', '').slice(0, 8) <= asOf),
      monthly_bars: block.monthly_bars?.filter((bar) => bar[0].replaceAll('-', '').slice(0, 8) <= asOf),
    })),
    limit_up_records: (history.limit_up_records ?? []).filter((record) => {
      const date = record.date.replaceAll('-', '').slice(0, 8);
      return calSet.has(date);
    }),
  };
}

function percentile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(sortedAsc.length * q)));
  return sortedAsc[idx];
}

function buildBuckets(
  random: number[],
  current: number,
): OverfitBucket[] {
  if (!random.length) return [];
  const min = Math.min(...random, current);
  const max = Math.max(...random, current);
  const range = max - min || 1;
  const buckets: OverfitBucket[] = [];
  for (let i = 0; i < WINDOW_BUCKETS; i += 1) {
    const lower = min + (range * i) / WINDOW_BUCKETS;
    const upper = i === WINDOW_BUCKETS - 1 ? max : min + (range * (i + 1)) / WINDOW_BUCKETS;
    const count = random.filter((v) => v >= lower && (i === WINDOW_BUCKETS - 1 ? v <= upper : v < upper)).length;
    const contains = current >= lower && (i === WINDOW_BUCKETS - 1 ? current <= upper : current < upper);
    buckets.push({ lower, upper, count, containsCurrent: contains });
  }
  return buckets;
}

function pickVerdict(cv: number, percentile: number): { verdict: OverfitAnalysisResult['verdict']; summary: string } {
  if (cv < STABLE_CV_THRESHOLD && percentile < TAIL_PERCENTILE_THRESHOLD) {
    return { verdict: 'ok', summary: '跨窗口稳定，且当前方案未明显跑赢随机分布 → 不像过拟合' };
  }
  if (cv >= STABLE_CV_THRESHOLD && percentile < TAIL_PERCENTILE_THRESHOLD) {
    return {
      verdict: 'warn_unstable',
      summary: `跨窗口不稳定（CV=${cv.toFixed(2)}），但绝对收益并未明显跑赢随机分布`,
    };
  }
  if (cv < STABLE_CV_THRESHOLD && percentile >= TAIL_PERCENTILE_THRESHOLD) {
    return {
      verdict: 'warn_tail',
      summary: '跨窗口稳定，但当前方案明显跑赢随机分布（注意：可能真有 alpha，也可能因为随机参数范围窄）',
    };
  }
  return {
    verdict: 'risk',
    summary: `跨窗口不稳定 + 当前方案在分布尾部（CV=${cv.toFixed(2)}，百分位 ${percentile.toFixed(0)}%）→ 高概率过拟合`,
  };
}

function runCurrentOnWindow(
  history: HistoricalMarketData,
  startIndex: number,
  days: number,
  label: string,
  base: OverfitAnalysisOptions['base'],
  scoringConfig: ScoreStockConfig | undefined,
): OverfitWindowResult {
  const sliced = sliceHistory(history, startIndex, days);
  const result = runPolarsBacktest(sliced, {
    days,
    maxHoldDays: base.maxHoldDays,
    maxPositions: base.maxPositions,
    positionSizePct: base.positionSizePct,
    takeProfitPct: base.takeProfitPct,
    stopLossPct: base.stopLossPct,
    trendWeightPct: base.trendWeightPct,
    volumePriceWeightPct: base.volumePriceWeightPct,
    distanceFromLowWeightPct: base.distanceFromLowWeightPct,
    volatilityTrendWeightPct: base.volatilityTrendWeightPct,
    relativeStrengthWeightPct: base.relativeStrengthWeightPct,
    scoringConfig,
  });
  return {
    label,
    startIndex,
    days,
    date_range: result.date_range,
    total_return_pct: result.summary.total_return_pct,
    win_rate: result.summary.win_rate,
    max_drawdown_pct: result.summary.max_drawdown_pct ?? 0,
    total_trades: result.summary.total_trades,
    run_id: result.run_id,
  };
}

export function runOverfitAnalysis(
  history: HistoricalMarketData,
  options: OverfitAnalysisOptions,
): OverfitAnalysisResult {
  const totalDays = history.calendar.length;
  if (totalDays < 30) {
    throw new Error(`历史行情不足 ${totalDays} 个交易日，至少需要 30 个才能做有意义的窗口对比`);
  }
  const requestedDays = Math.min(options.days, totalDays);
  const strategyCount = Math.min(200, Math.max(20, Math.trunc(options.strategyCount || 50)));
  const progress = options.onProgress ?? (() => {});

  progress('windows', 5, `阶段1：在前/中/后 3 段窗口（共 ${requestedDays} 日）跑当前方案`);
  const windowSpan = Math.min(requestedDays, totalDays);
  const windowDefs: Array<{ label: string; startIndex: number; days: number }> = [
    { label: `前段 (D0-D${windowSpan - 1})`, startIndex: 0, days: windowSpan },
    { label: `中段 (D${Math.floor(windowSpan / 3)}-D${windowSpan - Math.floor(windowSpan / 3) - 1})`, startIndex: Math.floor(windowSpan / 3), days: windowSpan - Math.floor(windowSpan / 3) },
    { label: `后段 (D${totalDays - windowSpan}-D${totalDays - 1})`, startIndex: Math.max(0, totalDays - windowSpan), days: windowSpan },
  ];

  const windows: OverfitWindowResult[] = [];
  for (let i = 0; i < windowDefs.length; i += 1) {
    const def = windowDefs[i];
    progress('windows', 5 + Math.round((i / windowDefs.length) * 25), `阶段1：${def.label}`);
    windows.push(runCurrentOnWindow(history, def.startIndex, def.days, def.label, options.base, options.scoringConfig));
  }
  const returns = windows.map((w) => w.total_return_pct);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const cv = mean !== 0 ? Math.abs(std / mean) : std === 0 ? 0 : Number.POSITIVE_INFINITY;
  const cvFlag: 'stable' | 'unstable' = cv < STABLE_CV_THRESHOLD ? 'stable' : 'unstable';

  // 回撤跨窗口统计
  const drawdowns = windows.map((w) => w.max_drawdown_pct);
  const drawdownMean = drawdowns.reduce((a, b) => a + b, 0) / drawdowns.length;
  const drawdownVariance = drawdowns.reduce((s, v) => s + (v - drawdownMean) ** 2, 0) / drawdowns.length;
  const drawdownStd = Math.sqrt(drawdownVariance);
  const drawdownCv = drawdownMean !== 0 ? Math.abs(drawdownStd / drawdownMean) : drawdownStd === 0 ? 0 : Number.POSITIVE_INFINITY;
  const drawdownCvFlag: 'stable' | 'unstable' = drawdownCv < STABLE_CV_THRESHOLD ? 'stable' : 'unstable';

  progress('random', 35, `阶段2：在最末窗口上跑 ${strategyCount} 组随机参数组合`);
  const lastWindow = windowDefs[windowDefs.length - 1];
  const lastSliced = sliceHistory(history, lastWindow.startIndex, lastWindow.days);
  const randomResults: BacktestResult[] = [];
  for (let i = 0; i < strategyCount; i += 1) {
    const [combo] = runRandomizedBacktest(lastSliced, {
      days: lastWindow.days,
      strategyCount: 1,
      maxHoldDaysUpper: options.base.maxHoldDays,
      maxPositionsUpper: options.base.maxPositions,
      positionSizePctUpper: options.base.positionSizePct,
      takeProfitPctUpper: options.base.takeProfitPct,
      stopLossPctUpper: Math.abs(options.base.stopLossPct),
      trendWeightPctUpper: options.base.trendWeightPct,
      volumePriceWeightPctUpper: options.base.volumePriceWeightPct,
      distanceFromLowWeightPctUpper: options.base.distanceFromLowWeightPct,
      volatilityTrendWeightPctUpper: options.base.volatilityTrendWeightPct,
      relativeStrengthWeightPctUpper: options.base.relativeStrengthWeightPct,
      scoringConfig: options.scoringConfig,
    });
    if (combo) randomResults.push(combo);
    progress('random', 35 + Math.round(((i + 1) / strategyCount) * 55), `阶段2：随机组合 ${i + 1}/${strategyCount}`);
  }
  const randomReturns = randomResults.map((r) => r.summary.total_return_pct).sort((a, b) => a - b);
  const lastWindowCurrent = windows[windows.length - 1].total_return_pct;
  const currentPercentile = randomReturns.length
    ? (randomReturns.filter((r) => r < lastWindowCurrent).length / randomReturns.length) * 100
    : 0;
  const inTail = currentPercentile >= TAIL_PERCENTILE_THRESHOLD;

  // 回撤随机分布
  const randomDrawdowns = randomResults.map((r) => r.summary.max_drawdown_pct ?? 0).sort((a, b) => a - b);
  const lastWindowDrawdown = windows[windows.length - 1].max_drawdown_pct;
  const currentDrawdownPercentile = randomDrawdowns.length
    ? (randomDrawdowns.filter((d) => d < lastWindowDrawdown).length / randomDrawdowns.length) * 100
    : 0;
  const drawdownInTail = currentDrawdownPercentile >= TAIL_PERCENTILE_THRESHOLD;

  progress('summary', 92, '汇总结论与分布');
  const buckets = buildBuckets(randomReturns, lastWindowCurrent);
  const drawdownBuckets = buildBuckets(randomDrawdowns, lastWindowDrawdown);
  const { verdict, summary } = pickVerdict(cv, currentPercentile);

  // 基线回测（用整段历史跑一次当前方案作为展示对照）
  const baseResult = runPolarsBacktest(history, {
    days: requestedDays,
    maxHoldDays: options.base.maxHoldDays,
    maxPositions: options.base.maxPositions,
    positionSizePct: options.base.positionSizePct,
    takeProfitPct: options.base.takeProfitPct,
    stopLossPct: options.base.stopLossPct,
    trendWeightPct: options.base.trendWeightPct,
    volumePriceWeightPct: options.base.volumePriceWeightPct,
    distanceFromLowWeightPct: options.base.distanceFromLowWeightPct,
    volatilityTrendWeightPct: options.base.volatilityTrendWeightPct,
    relativeStrengthWeightPct: options.base.relativeStrengthWeightPct,
    scoringConfig: options.scoringConfig,
  });

  return {
    base_run_id: baseResult.run_id,
    base_summary: listSummary(baseResult),
    windows,
    mean_return_pct: mean,
    std_return_pct: std,
    cv,
    cv_flag: cvFlag,
    random_sample_size: randomResults.length,
    random_min: randomReturns[0] ?? 0,
    random_max: randomReturns[randomReturns.length - 1] ?? 0,
    random_percentiles: {
      P25: percentile(randomReturns, 0.25),
      P50: percentile(randomReturns, 0.5),
      P75: percentile(randomReturns, 0.75),
      P90: percentile(randomReturns, 0.9),
      P99: percentile(randomReturns, 0.99),
    },
    current_percentile: currentPercentile,
    current_in_tail: inTail,
    buckets,
    mean_drawdown_pct: drawdownMean,
    std_drawdown_pct: drawdownStd,
    drawdown_cv: drawdownCv,
    drawdown_cv_flag: drawdownCvFlag,
    random_drawdown_min: randomDrawdowns[0] ?? 0,
    random_drawdown_max: randomDrawdowns[randomDrawdowns.length - 1] ?? 0,
    random_drawdown_percentiles: {
      P25: percentile(randomDrawdowns, 0.25),
      P50: percentile(randomDrawdowns, 0.5),
      P75: percentile(randomDrawdowns, 0.75),
      P90: percentile(randomDrawdowns, 0.9),
      P99: percentile(randomDrawdowns, 0.99),
    },
    current_drawdown_percentile: currentDrawdownPercentile,
    current_drawdown_in_tail: drawdownInTail,
    drawdown_buckets: drawdownBuckets,
    verdict,
    verdict_summary: summary,
    methodology:
      '在同一段历史上取前/中/后三段等价长度的窗口各跑一次当前方案，统计跨窗口收益的变异系数（CV=标准差/均值）。' +
      '然后在最末窗口上以当前方案为上界随机生成 N 组参数，统计当前方案在随机分布中的百分位。' +
      'CV<0.5 且百分位<90 视为稳定，CV>=0.5 或百分位>=90 视为有风险信号。',
    bias_notes: [
      '股票池来自当前可用排行快照，存在幸存者偏差，三段窗口共用同一股票池。',
      '随机参数以当前方案为上界采样，因此分布反映"在当前方案的邻域内"是否异常突出，' +
        '若当前方案本身就是"经过调参的最优点"，百分位偏高不必然等同于过拟合。',
    ],
  };
}

export type { FactorWeights };
