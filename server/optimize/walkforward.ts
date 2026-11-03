/**
 * Walk-forward 参数搜索 + 参数稳定性分析（P3）。
 *
 * 目标：把「全区间网格搜索」升级为「滚动样本外验证 + 参数稳定性评估」，抑制过拟合。
 *
 * 口径说明：
 * - 窗口切分按**交易日**计数，默认窗口 250 日、步长 60 日、训练段占比 0.7。
 *   默认值按当前策略的平均持仓 5 日、每日最多 2 笔进场的换手特性选取：
 *   250 日训练段足以覆盖 50 次独立持仓周期，60 日步长让相邻窗口重叠 76%，
 *   既保证样本外验证段足够长（90 日），又不至于让相邻窗口完全重复。
 * - 每个窗口：训练段做网格搜索，验证段只做评估（不使用验证段信息做任何选择）。
 * - 指标全部来自 P1 统一指标模块（metrics/performance.ts），本文件不自行计算指标。
 * - 稳定性得分：邻域组合样本外夏普的 均值 / (1 + 标准差)；
 *   邻域 = 网格中每个维度 ±1 步的组合（参数边界处截断，不越界取点）。
 * - 悬崖型组合：自身样本外夏普显著高于邻域均值，标记 `unstable: true` 并降权
 *   （排序分取邻域均值）。
 *
 * 可复现性：搜索空间是**全量网格**且求值顺序固定；并列时的 tie-break 使用固定
 * 随机源（seed 派生的确定性随机值），因此同一份数据 + 同一网格 + 同一 seed
 * 的结果完全可复现。
 */

import { round } from '../format.js';
import {
  computeMetrics,
  filterEquityByRange,
  filterTradesByRange,
  DEFAULT_MIN_TRADE_COUNT,
  type DateRange,
  type EquityPoint,
  type PerformanceMetrics,
  type PerformanceTrade,
} from '../metrics/performance.js';

/** 默认窗口长度（交易日）。 */
export const DEFAULT_WALKFORWARD_WINDOW_SIZE = 250;
/** 默认滚动步长（交易日）。 */
export const DEFAULT_WALKFORWARD_STEP_SIZE = 60;
/** 默认训练段占窗口比例。 */
export const DEFAULT_WALKFORWARD_TRAIN_RATIO = 0.7;
/** 窗口数低于该值时提示样本外统计意义有限。 */
export const MIN_STATISTICAL_WINDOW_COUNT = 4;
/** 悬崖判定阈值：自身样本外夏普高出邻域均值的绝对幅度。 */
export const DEFAULT_CLIFF_THRESHOLD = 0.5;
/**
 * 悬崖判定阈值（相对倍数）：自身样本外夏普至少是邻域均值的这么多倍。
 *
 * 只看绝对差会把「平滑最优区」误判成悬崖（平滑峰顶的邻域也不差），
 * 因此叠加相对判定：邻域均值已经很高时不算悬崖，邻域明显更差时才算。
 */
export const DEFAULT_CLIFF_RATIO = 2;
/** 固定随机源（仅用于并列时的确定性 tie-break）。 */
export const DEFAULT_WALKFORWARD_SEED = 20240101;

/** 参数组合：维度名 → 数值。 */
export type WalkForwardParams = Record<string, number>;

/** 参数网格：维度名 → 升序候选值列表。 */
export interface WalkForwardGrid {
  dimensions: Record<string, number[]>;
}

/** 单次求值结果（需要成交与净值才能按区间切分指标）。 */
export interface WalkForwardEvaluation {
  metrics: PerformanceMetrics;
  trades: PerformanceTrade[];
  equityCurve: EquityPoint[];
}

/**
 * 求值器：对一组参数在指定日期区间上跑一次回测。
 * 允许返回 Promise，便于调用方把重活放进 worker 池并行执行。
 */
export type WalkForwardEvaluator = (
  params: WalkForwardParams,
  range: DateRange,
) => WalkForwardEvaluation | Promise<WalkForwardEvaluation>;

export interface WalkForwardOptions {
  /** 窗口长度（交易日），默认 250。 */
  windowSize?: number;
  /** 滚动步长（交易日），默认 60。 */
  stepSize?: number;
  /** 训练段占窗口比例，默认 0.7。 */
  trainRatio?: number;
  /** 统计意义门槛（已平仓交易笔数），沿用 P1。 */
  minTradeCount?: number;
  /** 悬崖判定阈值（夏普绝对差），默认 0.5。 */
  cliffThreshold?: number;
  /** 悬崖判定阈值（邻域均值的相对倍数），默认 2。 */
  cliffRatio?: number;
  /** 固定随机源，默认 20240101。 */
  randomSeed?: number;
  /** 初始资金（用于换手率等指标），默认 100000。 */
  initialCapital?: number;
  /** 并发度：>1 时按并发上限并行求值（求值器需支持异步）。 */
  concurrency?: number;
}

export interface WalkForwardWindowResult {
  index: number;
  trainRange: DateRange;
  testRange: DateRange;
  /** 训练段选出的最优参数。 */
  bestParams: WalkForwardParams;
  /** 最优参数在训练段的指标。 */
  trainMetrics: PerformanceMetrics;
  /** 最优参数在验证段的指标（样本外）。 */
  testMetrics: PerformanceMetrics;
  /** 该窗口参与评估的参数组合数。 */
  evaluatedCombos: number;
}

export interface WalkForwardCandidateReport {
  params: WalkForwardParams;
  /** 各窗口训练段指标拼接后的结果。 */
  inSample: PerformanceMetrics;
  /** 各窗口验证段指标拼接后的结果（样本外）。 */
  outOfSample: PerformanceMetrics;
  /** 稳定性得分 = 邻域样本外夏普均值 / (1 + 邻域标准差)。 */
  stabilityScore: number;
  /** 邻域样本外夏普均值。 */
  neighborMean: number;
  /** 邻域样本外夏普标准差。 */
  neighborStd: number;
  /** 有效邻域组合数。 */
  neighborCount: number;
  /** 悬崖型组合标记。 */
  unstable: boolean;
  /** 排序分（不稳定组合降权后取邻域均值）。 */
  rankScore: number;
  /** 样本外交易次数是否不足。 */
  insufficient: boolean;
}

export interface WalkForwardResult {
  windows: WalkForwardWindowResult[];
  /** 各窗口验证段拼接后的整体指标（参数轨迹的样本外表现）。 */
  aggregate: PerformanceMetrics;
  /** 所有参数组合的横向评估，按排序分降序。 */
  candidates: WalkForwardCandidateReport[];
  /** 排序第一的参数组合（样本外夏普最优且未降权）。 */
  best: WalkForwardCandidateReport | null;
  /** 统计意义与数据不足等提示。 */
  warnings: string[];
  config: Required<Pick<WalkForwardOptions,
    'windowSize' | 'stepSize' | 'trainRatio' | 'minTradeCount' | 'cliffThreshold' | 'randomSeed' | 'initialCapital'>>;
}

interface Combo {
  params: WalkForwardParams;
  /** 每个维度在候选值列表中的下标。 */
  positions: number[];
}

/** 窗口定义：训练段 + 验证段。 */
export interface WalkForwardWindow {
  index: number;
  trainRange: DateRange;
  testRange: DateRange;
}

/**
 * 按交易日切分滚动窗口。
 *
 * @param calendar 交易日历（YYYYMMDD，升序）
 */
export function buildWalkForwardWindows(
  calendar: readonly string[],
  options: WalkForwardOptions = {},
): WalkForwardWindow[] {
  const windowSize = Math.max(2, Math.trunc(options.windowSize ?? DEFAULT_WALKFORWARD_WINDOW_SIZE));
  const stepSize = Math.max(1, Math.trunc(options.stepSize ?? DEFAULT_WALKFORWARD_STEP_SIZE));
  const trainRatio = Math.min(0.99, Math.max(0.01, options.trainRatio ?? DEFAULT_WALKFORWARD_TRAIN_RATIO));
  const days = [...calendar].sort();
  if (days.length < windowSize) return [];

  const trainCount = Math.max(1, Math.min(windowSize - 1, Math.floor(windowSize * trainRatio)));
  const windows: WalkForwardWindow[] = [];
  for (let start = 0; start + windowSize <= days.length; start += stepSize) {
    const windowDays = days.slice(start, start + windowSize);
    windows.push({
      index: windows.length,
      trainRange: { start: windowDays[0], end: windowDays[trainCount - 1] },
      testRange: { start: windowDays[trainCount], end: windowDays[windowDays.length - 1] },
    });
  }
  return windows;
}

/** 枚举网格的全部参数组合（顺序固定，保证可复现）。 */
export function enumerateCombos(grid: WalkForwardGrid): WalkForwardParams[] {
  const dims = Object.entries(grid.dimensions).filter(([, values]) => values.length > 0);
  if (!dims.length) return [];
  let combos: WalkForwardParams[] = [{}];
  for (const [name, values] of dims) {
    const next: WalkForwardParams[] = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [name]: value });
    }
    combos = next;
  }
  return combos;
}

function buildComboIndex(grid: WalkForwardGrid): { combos: Combo[]; strides: number[]; sizes: number[] } {
  const dims = Object.entries(grid.dimensions).filter(([, values]) => values.length > 0);
  const sizes = dims.map(([, values]) => values.length);
  const strides: number[] = new Array(sizes.length);
  let stride = 1;
  for (let index = sizes.length - 1; index >= 0; index -= 1) {
    strides[index] = stride;
    stride *= sizes[index];
  }
  const combos: Combo[] = [];
  const dimNames = dims.map(([name]) => name);
  // enumerateCombos 的枚举顺序是「最后一个维度变化最快」，与 strides 一致，
  // 因此邻域下标可以直接用 comboIndex + delta * strides[dim] 计算。
  for (const params of enumerateCombos(grid)) {
    const positions = dimNames.map((name, index) => dims[index][1].indexOf(params[name]));
    combos.push({ params, positions });
  }
  return { combos, strides, sizes };
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** 确定性伪随机（固定随机源），用于并列时的 tie-break。 */
function seededTieBreak(seed: number, key: string): number {
  let hash = 2166136261 ^ (seed >>> 0);
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  return (hash % 100000) / 100000;
}

function paramsKey(params: WalkForwardParams): string {
  return Object.keys(params).sort().map((key) => `${key}:${params[key]}`).join('|');
}

interface SliceResult {
  metrics: PerformanceMetrics;
  trades: PerformanceTrade[];
  equity: EquityPoint[];
}

function sliceEvaluation(
  evaluation: WalkForwardEvaluation,
  range: DateRange,
  initialCapital: number,
): SliceResult {
  const trades = filterTradesByRange(evaluation.trades, range);
  const equity = filterEquityByRange(evaluation.equityCurve, range);
  return {
    metrics: computeMetrics({ trades, equityCurve: equity, initialCapital }),
    trades,
    equity,
  };
}

/**
 * 把多段净值拼接为连续曲线：每段按上一段的累计收益比例缩放，
 * 使跨窗口拼接后的年化/回撤口径可用。
 */
function chainEquity(segments: EquityPoint[][], initialCapital: number): EquityPoint[] {
  const result: EquityPoint[] = [];
  let factor = 1;
  for (const segment of segments) {
    if (!segment.length) continue;
    const base = segment[0].total;
    for (const point of segment) {
      result.push({
        date: point.date,
        total: round(base > 0 ? point.total / base * initialCapital * factor : point.total, 6),
      });
    }
    const last = segment.at(-1)!.total;
    if (base > 0) factor *= last / base;
  }
  return result;
}

function aggregateSegments(
  segments: SliceResult[],
  initialCapital: number,
): { metrics: PerformanceMetrics; trades: PerformanceTrade[]; equity: EquityPoint[] } {
  const trades = segments.flatMap((segment) => segment.trades);
  const equity = chainEquity(segments.map((segment) => segment.equity), initialCapital);
  return {
    metrics: computeMetrics({ trades, equityCurve: equity, initialCapital }),
    trades,
    equity,
  };
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (limit <= 1) {
    for (const item of items) await worker(item);
    return;
  }
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * 执行 walk-forward 搜索。
 *
 * @param grid 参数网格
 * @param calendar 交易日历（YYYYMMDD，升序）
 * @param evaluator 求值器：对一组参数在给定区间上跑回测
 */
export async function runWalkForward(
  grid: WalkForwardGrid,
  calendar: readonly string[],
  evaluator: WalkForwardEvaluator,
  options: WalkForwardOptions = {},
): Promise<WalkForwardResult> {
  const config = {
    windowSize: Math.max(2, Math.trunc(options.windowSize ?? DEFAULT_WALKFORWARD_WINDOW_SIZE)),
    stepSize: Math.max(1, Math.trunc(options.stepSize ?? DEFAULT_WALKFORWARD_STEP_SIZE)),
    trainRatio: Math.min(0.99, Math.max(0.01, options.trainRatio ?? DEFAULT_WALKFORWARD_TRAIN_RATIO)),
    minTradeCount: Math.max(0, Math.trunc(options.minTradeCount ?? DEFAULT_MIN_TRADE_COUNT)),
    cliffThreshold: options.cliffThreshold ?? DEFAULT_CLIFF_THRESHOLD,
    cliffRatio: options.cliffRatio ?? DEFAULT_CLIFF_RATIO,
    randomSeed: options.randomSeed ?? DEFAULT_WALKFORWARD_SEED,
    initialCapital: options.initialCapital ?? 100000,
  };
  const warnings: string[] = [];
  const windows = buildWalkForwardWindows(calendar, config);
  if (!windows.length) {
    warnings.push(`历史交易日不足一个完整窗口（需要 ${config.windowSize} 个交易日），无法执行 walk-forward。`);
    return {
      windows: [],
      aggregate: computeMetrics({ trades: [], initialCapital: config.initialCapital }),
      candidates: [],
      best: null,
      warnings,
      config,
    };
  }
  if (windows.length < MIN_STATISTICAL_WINDOW_COUNT) {
    warnings.push(
      `窗口数仅 ${windows.length} 个（少于 ${MIN_STATISTICAL_WINDOW_COUNT} 个），样本外统计意义有限，结论请谨慎使用。`,
    );
  }

  const { combos, strides, sizes } = buildComboIndex(grid);
  if (!combos.length) {
    warnings.push('参数网格为空，无法执行 walk-forward。');
    return {
      windows: [],
      aggregate: computeMetrics({ trades: [], initialCapital: config.initialCapital }),
      candidates: [],
      best: null,
      warnings,
      config,
    };
  }

  // 缓存：同一 (参数组合, 区间) 只求值一次。
  const evaluationCache = new Map<string, WalkForwardEvaluation>();
  const evaluateCached = async (
    params: WalkForwardParams,
    range: DateRange,
  ): Promise<WalkForwardEvaluation> => {
    const key = `${paramsKey(params)}@${range.start}-${range.end}`;
    const cached = evaluationCache.get(key);
    if (cached) return cached;
    const evaluation = await evaluator(params, range);
    evaluationCache.set(key, evaluation);
    return evaluation;
  };

  // 每个窗口：在训练段对全量网格求值，验证段只用于评估。
  const windowTrainSlices: SliceResult[][] = [];
  const windowTestSlices: SliceResult[][] = [];
  const windowBestIndexes: number[] = [];
  const windowResults: WalkForwardWindowResult[] = [];

  for (const window of windows) {
    const windowRange: DateRange = { start: window.trainRange.start, end: window.testRange.end };
    const evaluations: WalkForwardEvaluation[] = new Array(combos.length);
    await runWithConcurrency(
      combos.map((_, index) => index),
      Math.max(1, Math.trunc(options.concurrency ?? 1)),
      async (index) => {
        evaluations[index] = await evaluateCached(combos[index].params, windowRange);
      },
    );

    const trainSlices: SliceResult[] = new Array(combos.length);
    const testSlices: SliceResult[] = new Array(combos.length);
    let bestIndex = -1;
    let bestTrainSharpe = -Infinity;
    for (let index = 0; index < combos.length; index += 1) {
      const evaluation = evaluations[index];
      if (!evaluation) continue;
      const train = sliceEvaluation(evaluation, window.trainRange, config.initialCapital);
      const test = sliceEvaluation(evaluation, window.testRange, config.initialCapital);
      trainSlices[index] = train;
      testSlices[index] = test;
      if (train.metrics.tradeCount < config.minTradeCount) continue;
      if (train.metrics.sharpe > bestTrainSharpe) {
        bestTrainSharpe = train.metrics.sharpe;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) {
      // 训练段没有任何组合达到统计门槛：退回按训练段夏普最优（即使为 0），
      // 并在提示中说明，避免窗口结果缺口导致样本外无法拼接。
      let fallbackSharpe = -Infinity;
      for (let index = 0; index < trainSlices.length; index += 1) {
        const slice = trainSlices[index];
        if (!slice) continue;
        if (slice.metrics.sharpe > fallbackSharpe) {
          fallbackSharpe = slice.metrics.sharpe;
          bestIndex = index;
        }
      }
      warnings.push(`窗口 #${window.index + 1} 训练段无组合达到 ${config.minTradeCount} 笔交易，已按夏普最优降级选参。`);
    }
    const resolvedIndex = Math.max(0, bestIndex);
    const bestCombo = combos[resolvedIndex];
    windowTrainSlices.push(trainSlices);
    windowTestSlices.push(testSlices);
    windowBestIndexes.push(resolvedIndex);
    windowResults.push({
      index: window.index,
      trainRange: window.trainRange,
      testRange: window.testRange,
      bestParams: bestCombo.params,
      trainMetrics: trainSlices[resolvedIndex].metrics,
      testMetrics: testSlices[resolvedIndex].metrics,
      evaluatedCombos: combos.length,
    });
  }

  // 参数轨迹（每窗口训练段选优 → 验证段评估）的样本外拼接结果。
  const pathTestSegments = windowResults.map((_, index) => windowTestSlices[index][windowBestIndexes[index]]);
  const pathAggregate = aggregateSegments(pathTestSegments, config.initialCapital);
  if (pathAggregate.metrics.tradeCount < config.minTradeCount) {
    warnings.push(
      `样本外拼接后的已平仓交易仅 ${pathAggregate.metrics.tradeCount} 笔，低于 ${config.minTradeCount} 笔，样本外指标参考意义有限。`,
    );
  }

  // 横向：每个参数组合在所有窗口上的样本外表现。
  const candidateOutOfSample: PerformanceMetrics[] = [];
  const candidateInSample: PerformanceMetrics[] = [];
  for (let comboIndex = 0; comboIndex < combos.length; comboIndex += 1) {
    const trainSegments = windowTrainSlices.map((slices) => slices[comboIndex]).filter(Boolean);
    const testSegments = windowTestSlices.map((slices) => slices[comboIndex]).filter(Boolean);
    candidateInSample.push(aggregateSegments(trainSegments, config.initialCapital).metrics);
    candidateOutOfSample.push(aggregateSegments(testSegments, config.initialCapital).metrics);
  }

  // 邻域：每个维度 ±1 步（边界截断）。
  const neighborScores = combos.map((combo, comboIndex) => {
    const scores: number[] = [];
    for (let dim = 0; dim < combo.positions.length; dim += 1) {
      for (const delta of [-1, 1]) {
        const position = combo.positions[dim] + delta;
        if (position < 0 || position >= sizes[dim]) continue;
        const neighborIndex = comboIndex + delta * strides[dim];
        const neighbor = combos[neighborIndex];
        if (!neighbor) continue;
        scores.push(candidateOutOfSample[neighborIndex].sharpe);
      }
    }
    return scores;
  });

  const tieBreakByKey = new Map<string, number>();
  for (const combo of combos) {
    tieBreakByKey.set(paramsKey(combo.params), seededTieBreak(config.randomSeed, paramsKey(combo.params)));
  }

  const candidates: WalkForwardCandidateReport[] = combos.map((combo, index) => {
    const ownSharpe = candidateOutOfSample[index].sharpe;
    const neighbors = neighborScores[index];
    const neighborMean = mean(neighbors);
    const neighborStd = stdDev(neighbors);
    const stabilityScore = round(neighborMean / (1 + neighborStd), 4);
    const cliffGap = ownSharpe - neighborMean;
    // 悬崖判定同时看绝对差与相对倍数：
    // - 绝对差：自身明显高于邻域均值；
    // - 相对倍数：邻域均值本身已经很高时不算悬崖（那是平滑最优区）。
    const relativeCliff = neighborMean <= 0
      ? ownSharpe > config.cliffThreshold
      : ownSharpe >= neighborMean * config.cliffRatio;
    const unstable = neighbors.length > 0
      && cliffGap > config.cliffThreshold
      && relativeCliff;
    return {
      params: combo.params,
      inSample: candidateInSample[index],
      outOfSample: candidateOutOfSample[index],
      stabilityScore,
      neighborMean: round(neighborMean, 4),
      neighborStd: round(neighborStd, 4),
      neighborCount: neighbors.length,
      unstable,
      // 悬崖型组合降权：排序分取邻域均值（低于自身夏普）。
      rankScore: round(unstable ? neighborMean : ownSharpe, 4),
      insufficient: candidateOutOfSample[index].tradeCount < config.minTradeCount,
    };
  });

  candidates.sort((left, right) => {
    if (right.rankScore !== left.rankScore) return right.rankScore - left.rankScore;
    if (right.stabilityScore !== left.stabilityScore) return right.stabilityScore - left.stabilityScore;
    // 固定随机源派生 tie-break：排序结果完全可复现。
    return (tieBreakByKey.get(paramsKey(left.params)) ?? 0) - (tieBreakByKey.get(paramsKey(right.params)) ?? 0);
  });

  const best = candidates.find((candidate) => !candidate.unstable) ?? candidates[0] ?? null;

  return {
    windows: windowResults,
    aggregate: pathAggregate.metrics,
    candidates,
    best,
    warnings,
    config,
  };
}
