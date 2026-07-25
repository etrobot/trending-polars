import { prepareBacktestContext, quickSimulateBacktest } from './backtest-engine.js';
import { round } from './format.js';
import type { HistoricalMarketData } from './historical-market.js';
import {
  DEFAULT_SCORE_STOCK_CONFIG,
  distanceFromLowScore,
  normalizeScoreStockConfig,
  type Alignment,
  type DistanceFromLowTier,
  type ScoreStockConfig,
  type TrendAxis,
} from './scoring-engine.js';
import { DEFAULT_T1_STRATEGY } from './trading-strategy.js';

// ---------------------------------------------------------------------------
// 两阶段参数优化（以完整回测收益为最终目标，而非截面相关性）：
// 阶段1 — 在候选 scoreStock 配置中，用默认交易参数跑回测，选收益最好的评分方案
// 阶段2 — 固定阶段1评分，宽范围搜索回测参数；若仍不如默认基线则回退默认
// ---------------------------------------------------------------------------

/** 阶段1 统计表用的固定评估窗口（非交易持有天数）。 */
export const SCORE_EVAL_FORWARD_DAYS = 5;

export interface OptimizedStrategyParams {
  maxHoldDays: number;
  maxPositions: number;
  positionSizePct: number;
  takeProfitPct: number;
  stopLossPct: number;
  trendWeightPct: number;
  volumePriceWeightPct: number;
  distanceFromLowWeightPct: number;
  volatilityWeightPct: number;
}

export interface BacktestValidation {
  totalReturnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  totalTrades: number;
}

export interface ScoreStockOptimizeResult {
  config: ScoreStockConfig;
  scoreCorrelation: number;
  topBottomSpreadPct: number;
  distanceBucketStats: DistanceBucketStats[];
  sweetSpotLabels: string[];
  backtestValidation: BacktestValidation;
}

export interface DistanceBucketStats {
  label: string;
  minPct: number;
  maxPct: number | null;
  sampleCount: number;
  avgForwardReturnPct: number;
  winRatePct: number;
  positionScore: number;
}

export interface ParamOptimizeResult {
  days: number;
  scoring: ScoreStockOptimizeResult;
  optimized: OptimizedStrategyParams;
  validation: BacktestValidation;
  baseline: {
    params: OptimizedStrategyParams;
    validation: BacktestValidation;
  };
  beatBaseline: boolean;
  methodology: string;
}

interface RawObservation {
  distancePct: number;
  alignment: Alignment;
  trendStrength: number;
  volumePriceScore: number;
  limitUpCount20d: number;
  sectorTrend?: TrendAxis;
  forwardByHold: Map<number, number>;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function defaultStrategyParams(): OptimizedStrategyParams {
  return {
    maxHoldDays: DEFAULT_T1_STRATEGY.maxHoldDays,
    maxPositions: DEFAULT_T1_STRATEGY.maxPositions,
    positionSizePct: DEFAULT_T1_STRATEGY.positionSizePct,
    takeProfitPct: DEFAULT_T1_STRATEGY.takeProfitPct,
    stopLossPct: Math.abs(DEFAULT_T1_STRATEGY.stopLossPct),
    trendWeightPct: 100,
    volumePriceWeightPct: 100,
    distanceFromLowWeightPct: 100,
    volatilityWeightPct: 100,
  };
}

/** 回测综合目标：收益为主，回撤惩罚，过少交易/极低胜率重罚。 */
function backtestObjective(summary: BacktestValidation): number {
  const tradePenalty = summary.totalTrades < 6 ? -12 : summary.totalTrades < 8 ? -4 : 0;
  const winRatePenalty = summary.winRate < 35 ? (35 - summary.winRate) * 0.08 : 0;
  return summary.totalReturnPct
    - Math.abs(summary.maxDrawdownPct) * 0.45
    + (summary.winRate >= 50 ? 1 : 0)
    + tradePenalty
    - winRatePenalty;
}

function correlation(xs: number[], ys: number[]): number {
  if (xs.length < 3 || xs.length !== ys.length) return 0;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (!varX || !varY) return 0;
  return cov / Math.sqrt(varX * varY);
}

function forwardReturn(observation: RawObservation, holdDays: number): number | null {
  return observation.forwardByHold.get(holdDays) ?? null;
}

function collectRawObservations(history: HistoricalMarketData, days: number): RawObservation[] {
  const context = prepareBacktestContext(history, days);
  const observations: RawObservation[] = [];

  for (let dateIndex = 0; dateIndex < context.dates.length - SCORE_EVAL_FORWARD_DAYS; dateIndex += 1) {
    const date = context.dates[dateIndex];
    const rows = context.scoreMap.get(date) ?? [];
    for (const row of rows) {
      const series = context.seriesByCode.get(row.stock_code);
      if (!series) continue;
      const barIndex = series.indexByDate.get(date);
      if (barIndex == null) continue;
      const exitIndex = barIndex + SCORE_EVAL_FORWARD_DAYS;
      if (exitIndex >= series.bars.length) continue;
      const entryClose = series.bars[barIndex].close;
      const exitClose = series.bars[exitIndex].close;
      if (entryClose <= 0 || exitClose <= 0) continue;

      observations.push({
        distancePct: row.distance_from_low_pct ?? 0,
        alignment: (row.alignment ?? 'tangled') as Alignment,
        trendStrength: row.trend_strength ?? 0,
        volumePriceScore: Number(row.volume_price_score ?? row.volume_score ?? 0),
        limitUpCount20d: row.limit_up_count_20d ?? 0,
        forwardByHold: new Map([[SCORE_EVAL_FORWARD_DAYS, round((exitClose - entryClose) / entryClose * 100, 2)]]),
      });
    }
  }

  console.log('[param-optimize] raw observations', { days: context.dates.length, count: observations.length });
  return observations;
}

function aggregateBucketStats(observations: RawObservation[], config: ScoreStockConfig): DistanceBucketStats[] {
  const tiers = [...config.distanceFromLow.tiers].sort((left, right) => left.maxPct - right.maxPct);
  const buckets: DistanceBucketStats[] = tiers.map((tier, index) => ({
    label: tier.label,
    minPct: index === 0 ? 0 : tiers[index - 1].maxPct,
    maxPct: tier.maxPct,
    sampleCount: 0,
    avgForwardReturnPct: 0,
    winRatePct: 0,
    positionScore: tier.score,
  }));
  buckets.push({
    label: config.distanceFromLow.extendedLabel,
    minPct: tiers.at(-1)?.maxPct ?? 80,
    maxPct: null,
    sampleCount: 0,
    avgForwardReturnPct: 0,
    winRatePct: 0,
    positionScore: config.distanceFromLow.extendedScore,
  });

  for (const observation of observations) {
    const label = distanceFromLowScore(observation.distancePct, config).label;
    const bucket = buckets.find((item) => item.label === label);
    if (!bucket) continue;
    const forward = forwardReturn(observation, SCORE_EVAL_FORWARD_DAYS);
    if (forward == null) continue;
    bucket.sampleCount += 1;
    bucket.avgForwardReturnPct += forward;
    if (forward > 0) bucket.winRatePct += 1;
  }

  for (const bucket of buckets) {
    if (!bucket.sampleCount) continue;
    bucket.avgForwardReturnPct = round(bucket.avgForwardReturnPct / bucket.sampleCount, 2);
    bucket.winRatePct = round(bucket.winRatePct / bucket.sampleCount * 100, 1);
  }
  return buckets;
}

function evaluateScoreDiagnostics(observations: RawObservation[], config: ScoreStockConfig) {
  const scores: number[] = [];
  const forwards: number[] = [];
  for (const observation of observations) {
    const forward = forwardReturn(observation, SCORE_EVAL_FORWARD_DAYS);
    if (forward == null) continue;
    const fromLow = distanceFromLowScore(observation.distancePct, config);
    scores.push(fromLow.score);
    forwards.push(forward);
  }
  const corr = correlation(scores, forwards);
  const ranked = scores.map((score, index) => ({ score, forward: forwards[index] }))
    .sort((left, right) => right.score - left.score);
  const topCount = Math.max(1, Math.floor(ranked.length * 0.2));
  const bottomCount = Math.max(1, Math.floor(ranked.length * 0.2));
  const topAvg = ranked.slice(0, topCount).reduce((sum, item) => sum + item.forward, 0) / topCount;
  const bottomAvg = ranked.slice(-bottomCount).reduce((sum, item) => sum + item.forward, 0) / bottomCount;
  return { correlation: round(corr, 3), spread: round(topAvg - bottomAvg, 2) };
}

function buildDistanceConfigFromStats(
  observations: RawObservation[],
  thresholds: { nearLow: number; earlyLeave: number; launchConfirm: number; trendUp: number; farFromLow: number },
): ScoreStockConfig['distanceFromLow'] {
  const tiers: DistanceFromLowTier[] = [
    { label: '贴近低点', maxPct: thresholds.nearLow, score: 4 },
    { label: '刚离低点', maxPct: thresholds.earlyLeave, score: 10 },
    { label: '启动确认', maxPct: thresholds.launchConfirm, score: 18 },
    { label: '趋势上行', maxPct: thresholds.trendUp, score: 20 },
    { label: '远离低点', maxPct: thresholds.farFromLow, score: 14 },
  ];

  for (const tier of tiers) {
    const probeConfig = normalizeScoreStockConfig({
      distanceFromLow: { ...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow, tiers },
    });
    const returns = observations
      .filter((item) => distanceFromLowScore(item.distancePct, probeConfig).label === tier.label)
      .map((item) => forwardReturn(item, SCORE_EVAL_FORWARD_DAYS))
      .filter((value): value is number => value != null);
    if (!returns.length) continue;
    const avg = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const winRate = returns.filter((value) => value > 0).length / returns.length;
    tier.score = clampInt(4 + Math.max(0, avg) * 1.5 + winRate * 10, 2, 20);
  }

  return {
    atLowScore: DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow.atLowScore,
    extendedScore: DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow.extendedScore,
    extendedLabel: '高位延伸',
    tiers,
  };
}

function scoreConfigCandidates(observations: RawObservation[]): ScoreStockConfig[] {
  const thresholdGrid = [
    { nearLow: 5, earlyLeave: 15, launchConfirm: 30, trendUp: 50, farFromLow: 80 },
    { nearLow: 5, earlyLeave: 12, launchConfirm: 25, trendUp: 45, farFromLow: 75 },
    { nearLow: 5, earlyLeave: 18, launchConfirm: 35, trendUp: 55, farFromLow: 85 },
  ];
  const trendGrid = [
    { trendBonusMultiplier: 400, bullishAlignment: 28 },
    { trendBonusMultiplier: 300, bullishAlignment: 24 },
    { trendBonusMultiplier: 500, bullishAlignment: 32 },
  ];

  const candidates: ScoreStockConfig[] = [normalizeScoreStockConfig()];
  for (const thresholds of thresholdGrid) {
    for (const trend of trendGrid) {
      candidates.push(normalizeScoreStockConfig({
        distanceFromLow: buildDistanceConfigFromStats(observations, thresholds),
        trend,
      }));
    }
  }
  return candidates;
}

function optimizeScoreStockConfig(
  history: HistoricalMarketData,
  days: number,
  observations: RawObservation[],
  tradingDefaults: OptimizedStrategyParams,
): ScoreStockOptimizeResult {
  let bestConfig = DEFAULT_SCORE_STOCK_CONFIG;
  let bestValidation: BacktestValidation = {
    totalReturnPct: Number.NEGATIVE_INFINITY,
    winRate: 0,
    maxDrawdownPct: 0,
    totalTrades: 0,
  };
  let bestObjective = Number.NEGATIVE_INFINITY;
  let bestDiagnostics = { correlation: 0, spread: 0 };

  const candidates = scoreConfigCandidates(observations);
  console.log('[param-optimize] phase1 candidates', candidates.length);

  for (const config of candidates) {
    const context = prepareBacktestContext(history, days, config);
    const validation = quickSimulateBacktest(context, tradingDefaults);
    const objective = backtestObjective(validation);
    if (objective > bestObjective) {
      bestObjective = objective;
      bestConfig = config;
      bestValidation = validation;
      bestDiagnostics = evaluateScoreDiagnostics(observations, config);
    }
  }

  const bucketStats = aggregateBucketStats(observations, bestConfig);
  const rankedBuckets = [...bucketStats]
    .filter((item) => item.sampleCount >= 5 && item.avgForwardReturnPct > 0)
    .sort((left, right) => right.avgForwardReturnPct - left.avgForwardReturnPct || right.winRatePct - left.winRatePct);
  const sweetSpotLabels = rankedBuckets.length
    ? rankedBuckets.slice(0, 2).map((item) => item.label)
    : ['启动确认', '趋势上行'];

  console.log('[param-optimize] phase1 scoreStock done', {
    objective: round(bestObjective, 2),
    backtestValidation: bestValidation,
    scoreCorrelation: bestDiagnostics.correlation,
    distanceTiers: bestConfig.distanceFromLow.tiers,
    trend: bestConfig.trend,
  });

  return {
    config: bestConfig,
    scoreCorrelation: bestDiagnostics.correlation,
    topBottomSpreadPct: bestDiagnostics.spread,
    distanceBucketStats: bucketStats,
    sweetSpotLabels,
    backtestValidation: bestValidation,
  };
}

function gridSearchBacktestParams(
  history: HistoricalMarketData,
  days: number,
  scoringConfig: ScoreStockConfig,
  seed: OptimizedStrategyParams,
): { params: OptimizedStrategyParams; validation: BacktestValidation; objective: number } {
  const context = prepareBacktestContext(history, days, scoringConfig);
  let bestParams = seed;
  let bestObjective = Number.NEGATIVE_INFINITY;
  let bestValidation: BacktestValidation = {
    totalReturnPct: 0,
    winRate: 0,
    maxDrawdownPct: 0,
    totalTrades: 0,
  };

  const holdDaysList = [3, 5, 7, 10, 15, 20];
  const takeProfitList = [10, 15, 20, 25, 30];
  const stopLossList = [5, 8, 10, 12, 15];

  let evaluated = 0;
  // 2a：核心交易参数
  for (const maxHoldDays of holdDaysList) {
    for (const takeProfitPct of takeProfitList) {
      for (const stopLossPct of stopLossList) {
        const candidate = { ...seed, maxHoldDays, takeProfitPct, stopLossPct };
        const validation = quickSimulateBacktest(context, candidate);
        evaluated += 1;
        const objective = backtestObjective(validation);
        if (objective > bestObjective) {
          bestObjective = objective;
          bestParams = candidate;
          bestValidation = validation;
        }
      }
    }
  }

  const maxPositionsList = [3, 5, 7, 10];
  const positionSizeList = [10, 15, 20, 25];
  const distanceWeightList = [70, 85, 100];
  const trendWeightList = [70, 85, 100];

  // 2b：在 2a 最优附近调仓位与因子权重
  for (const maxPositions of maxPositionsList) {
    for (const positionSizePct of positionSizeList) {
      for (const distanceFromLowWeightPct of distanceWeightList) {
        for (const trendWeightPct of trendWeightList) {
          const candidate: OptimizedStrategyParams = {
            ...bestParams,
            maxPositions,
            positionSizePct,
            distanceFromLowWeightPct,
            trendWeightPct,
          };
          const validation = quickSimulateBacktest(context, candidate);
          evaluated += 1;
          const objective = backtestObjective(validation);
          if (objective > bestObjective) {
            bestObjective = objective;
            bestParams = candidate;
            bestValidation = validation;
          }
        }
      }
    }
  }

  console.log('[param-optimize] phase2 backtest grid done', {
    evaluated,
    objective: round(bestObjective, 2),
    bestParams,
    bestValidation,
  });
  return { params: bestParams, validation: bestValidation, objective: bestObjective };
}

/**
 * 两阶段优化：以完整回测收益为准；若不如默认基线则回退默认参数。
 */
export function optimizeStrategyParams(
  history: HistoricalMarketData,
  options: { days?: number } = {},
): ParamOptimizeResult {
  const days = Math.min(60, Math.max(5, Math.trunc(options.days ?? 20)));
  const defaultParams = defaultStrategyParams();
  const observations = collectRawObservations(history, days);
  if (observations.length < 10) {
    throw new Error(`样本不足（${observations.length} 条），请先采集至少 ${days} 日历史行情`);
  }

  const baselineContext = prepareBacktestContext(history, days, DEFAULT_SCORE_STOCK_CONFIG);
  const baselineValidation = quickSimulateBacktest(baselineContext, defaultParams);
  const baselineObjective = backtestObjective(baselineValidation);
  console.log('[param-optimize] baseline', { defaultParams, baselineValidation, baselineObjective: round(baselineObjective, 2) });

  const scoring = optimizeScoreStockConfig(history, days, observations, defaultParams);
  const phase2 = gridSearchBacktestParams(history, days, scoring.config, defaultParams);

  const beatBaseline = phase2.objective > baselineObjective;
  const optimized = beatBaseline ? phase2.params : defaultParams;
  const validation = beatBaseline ? phase2.validation : baselineValidation;
  const finalScoring = beatBaseline
    ? scoring
    : {
      ...scoring,
      config: DEFAULT_SCORE_STOCK_CONFIG,
      backtestValidation: baselineValidation,
    };

  const methodology = beatBaseline
    ? `阶段1：${scoreConfigCandidates(observations).length} 组 scoreStock 以完整回测选优。`
      + `阶段2：搜索回测参数得 ${validation.totalReturnPct}%（胜率 ${validation.winRate}%），`
      + `超越默认基线 ${baselineValidation.totalReturnPct}%。`
    : `优化结果（${phase2.validation.totalReturnPct}%）未超越默认方案（${baselineValidation.totalReturnPct}%），已回退默认参数。`;

  console.log('[param-optimize] completed', {
    days,
    beatBaseline,
    baselineValidation,
    optimized,
    validation,
  });

  return {
    days,
    scoring: finalScoring,
    optimized,
    validation,
    baseline: { params: defaultParams, validation: baselineValidation },
    beatBaseline,
    methodology,
  };
}
