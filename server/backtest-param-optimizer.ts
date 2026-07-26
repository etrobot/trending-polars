import { prepareBacktestContext, quickSimulateBacktest } from './backtest-engine.js';
import { round } from './format.js';
import { type HistoricalMarketData } from './historical-market.js';
import {
  DEFAULT_SCORE_STOCK_CONFIG,
  distanceFromLowScore,
  normalizeScoreStockConfig,
  type Alignment,
  type DistanceFromLowTier,
  type ScoreStockConfig,
} from './scoring-engine.js';
import { DEFAULT_T1_STRATEGY } from './trading-strategy.js';

// ---------------------------------------------------------------------------
// 两阶段参数优化（以完整回测收益为最终目标）：
// 阶段1 — 每日按距60日低点收益降序取 Top N 正样本，提取特征分布生成候选 scoreStock
//         配置，用默认交易参数跑回测，选收益最好的评分方案
// 阶段2 — 固定阶段1评分，宽范围搜索回测参数；若仍不如默认基线则回退默认
// ---------------------------------------------------------------------------

/** 每日选取距60日低点收益最高的前 N 只股票作为正样本。 */
export const TOP_N_PER_DAY = 20;

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
  /** Top N 正样本的平均评分相对全体样本的领先幅度（分，>0 越理想）。 */
  topScoreGapPct: number;
  /** Top N 正样本集中度最高的分档占 Top N 总样本的比例（%）。 */
  topConcentrationPct: number;
  distanceBucketStats: DistanceBucketStats[];
  sweetSpotLabels: string[];
  backtestValidation: BacktestValidation;
}

export interface DistanceBucketStats {
  label: string;
  minPct: number;
  maxPct: number | null;
  /** 落在该分档的 Top N 正样本数量。 */
  sampleCount: number;
  /** 该分档 Top N 正样本的平均距60日低点收益（%）。 */
  avgDistancePct: number;
  /** 该分档 Top N 正样本占 Top N 总数的比例（%）。 */
  topConcentrationPct: number;
  positionScore: number;
}

export interface ParamOptimizeResult {
  days: number;
  topN: number;
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
  // 亏损策略直接给最低分，避免 optimizer 在熊市挑"亏最少"的自欺欺人
  if (summary.totalReturnPct <= 0) return Number.NEGATIVE_INFINITY;
  const tradePenalty = summary.totalTrades < 6 ? -12 : summary.totalTrades < 8 ? -4 : 0;
  const winRatePenalty = summary.winRate < 40 ? (40 - summary.winRate) * 0.1 : 0;
  return summary.totalReturnPct
    - Math.abs(summary.maxDrawdownPct) * 0.45
    + (summary.winRate >= 50 ? 1 : 0)
    + tradePenalty
    - winRatePenalty;
}

/**
 * 构建正样本观测：每天按距60日低点收益降序取前 TOP_N_PER_DAY 名。
 * 使用 prepareBacktestContext 的 scoreMap 按天分组排序取 Top N。
 */
function collectRawObservations(history: HistoricalMarketData, days: number): RawObservation[] {
  const context = prepareBacktestContext(history, days);
  const observations: RawObservation[] = [];

  for (const date of context.dates) {
    const rows = context.scoreMap.get(date) ?? [];
    // 按 distance_from_low_pct 降序取 Top N
    const topN = [...rows]
      .filter((row) => Number.isFinite(row.distance_from_low_pct))
      .sort((a, b) => (b.distance_from_low_pct ?? 0) - (a.distance_from_low_pct ?? 0))
      .slice(0, TOP_N_PER_DAY);

    for (const row of topN) {
      observations.push({
        distancePct: row.distance_from_low_pct ?? 0,
        alignment: (row.alignment ?? 'tangled') as Alignment,
        trendStrength: row.trend_strength ?? 0,
        volumePriceScore: Number(row.volume_price_score ?? row.volume_score ?? 0),
        limitUpCount20d: row.limit_up_count_20d ?? 0,
      });
    }
  }

  console.log('[param-optimize] top-N observations', {
    days: context.dates.length,
    topN: TOP_N_PER_DAY,
    count: observations.length,
  });
  return observations;
}

function aggregateBucketStats(observations: RawObservation[], config: ScoreStockConfig): DistanceBucketStats[] {
  const tiers = [...config.distanceFromLow.tiers].sort((left, right) => left.maxPct - right.maxPct);
  const buckets: DistanceBucketStats[] = tiers.map((tier, index) => ({
    label: tier.label,
    minPct: index === 0 ? 0 : tiers[index - 1].maxPct,
    maxPct: tier.maxPct,
    sampleCount: 0,
    avgDistancePct: 0,
    topConcentrationPct: 0,
    positionScore: tier.score,
  }));
  buckets.push({
    label: config.distanceFromLow.extendedLabel,
    minPct: tiers.at(-1)?.maxPct ?? 80,
    maxPct: null,
    sampleCount: 0,
    avgDistancePct: 0,
    topConcentrationPct: 0,
    positionScore: config.distanceFromLow.extendedScore,
  });

  const total = observations.length;
  for (const observation of observations) {
    const label = distanceFromLowScore(observation.distancePct, config).label;
    const bucket = buckets.find((item) => item.label === label);
    if (!bucket) continue;
    bucket.sampleCount += 1;
    bucket.avgDistancePct += observation.distancePct;
  }

  for (const bucket of buckets) {
    if (!bucket.sampleCount) continue;
    bucket.avgDistancePct = round(bucket.avgDistancePct / bucket.sampleCount, 2);
    bucket.topConcentrationPct = total > 0 ? round(bucket.sampleCount / total * 100, 1) : 0;
  }
  return buckets;
}

/** 评估评分配置对 Top N 正样本的区分度：Top N 平均评分 vs 全体平均评分的差距。 */
function evaluateScoreDiagnostics(
  observations: RawObservation[],
  config: ScoreStockConfig,
  allRowCount: number,
  allAvgScore: number,
) {
  if (!observations.length || allRowCount <= 0) {
    return { topScoreGap: 0, concentration: 0 };
  }
  let topScoreSum = 0;
  let topInBestBucket = 0;
  let bestBucketLabel: string | undefined;
  for (const observation of observations) {
    const fromLow = distanceFromLowScore(observation.distancePct, config);
    topScoreSum += fromLow.score;
    if (!bestBucketLabel || fromLow.score > (distanceFromLowScore(0, config).score)) {
      bestBucketLabel = fromLow.label;
    }
  }
  const topAvgScore = topScoreSum / observations.length;
  const topScoreGap = round(topAvgScore - allAvgScore, 2);

  for (const observation of observations) {
    const fromLow = distanceFromLowScore(observation.distancePct, config);
    if (fromLow.label === bestBucketLabel) topInBestBucket += 1;
  }
  const concentration = round(topInBestBucket / observations.length * 100, 1);
  return { topScoreGap, concentration };
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

  // 根据 Top N 正样本在各桶的集中度调整 tier.score
  // 集中度越高的桶（Top N 越倾向于落在该区间），给越高的分值
  const total = observations.length;
  for (const tier of tiers) {
    const probeConfig = normalizeScoreStockConfig({
      distanceFromLow: { ...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow, tiers },
    });
    const inTier = observations.filter((item) => distanceFromLowScore(item.distancePct, probeConfig).label === tier.label);
    if (!inTier.length) continue;
    const concentration = inTier.length / total;
    const avgDistance = inTier.reduce((sum, item) => sum + item.distancePct, 0) / inTier.length;
    tier.score = clampInt(4 + concentration * 12 + Math.max(0, avgDistance) * 0.08, 2, 20);
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

/** 计算全体样本的平均位置分（作为 Top N 对比的基线）。 */
function computeAllAvgPositionScore(history: HistoricalMarketData, days: number, config: ScoreStockConfig): { count: number; avgScore: number } {
  const context = prepareBacktestContext(history, days, config);
  let scoreSum = 0;
  let count = 0;
  for (const date of context.dates) {
    const rows = context.scoreMap.get(date) ?? [];
    for (const row of rows) {
      const distancePct = row.distance_from_low_pct ?? 0;
      if (!Number.isFinite(distancePct)) continue;
      scoreSum += distanceFromLowScore(distancePct, config).score;
      count += 1;
    }
  }
  return { count, avgScore: count ? scoreSum / count : 0 };
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
  let bestDiagnostics = { topScoreGap: 0, concentration: 0 };

  const candidates = scoreConfigCandidates(observations);
  console.log('[param-optimize] phase1 candidates', candidates.length);

  // 用默认 config 计算全体平均位置分作为对比基线
  const allBaseline = computeAllAvgPositionScore(history, days, DEFAULT_SCORE_STOCK_CONFIG);

  for (const config of candidates) {
    const context = prepareBacktestContext(history, days, config);
    const validation = quickSimulateBacktest(context, tradingDefaults);
    const objective = backtestObjective(validation);
    if (objective > bestObjective) {
      bestObjective = objective;
      bestConfig = config;
      bestValidation = validation;
      bestDiagnostics = evaluateScoreDiagnostics(observations, config, allBaseline.count, allBaseline.avgScore);
    }
  }

  const bucketStats = aggregateBucketStats(observations, bestConfig);
  // 优选区间：Top N 集中度最高的两个分档（sampleCount > 0）
  const rankedBuckets = [...bucketStats]
    .filter((item) => item.sampleCount > 0)
    .sort((left, right) => right.topConcentrationPct - left.topConcentrationPct || right.avgDistancePct - left.avgDistancePct);
  const sweetSpotLabels = rankedBuckets.length
    ? rankedBuckets.slice(0, 2).map((item) => item.label)
    : ['启动确认', '趋势上行'];

  console.log('[param-optimize] phase1 scoreStock done', {
    objective: round(bestObjective, 2),
    backtestValidation: bestValidation,
    topScoreGap: bestDiagnostics.topScoreGap,
    topConcentration: bestDiagnostics.concentration,
    distanceTiers: bestConfig.distanceFromLow.tiers,
    trend: bestConfig.trend,
  });

  return {
    config: bestConfig,
    topScoreGapPct: bestDiagnostics.topScoreGap,
    topConcentrationPct: bestDiagnostics.concentration,
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
  const days = Math.min(60, Math.max(5, Math.trunc(options.days ?? 60)));
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
    : baselineValidation.totalReturnPct <= 0
      ? `当前 ${days} 日市场环境下所有策略均未能盈利（最优仅 ${phase2.validation.totalReturnPct}%），已回退默认参数。`
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
    topN: TOP_N_PER_DAY,
    scoring: finalScoring,
    optimized,
    validation,
    baseline: { params: defaultParams, validation: baselineValidation },
    beatBaseline,
    methodology,
  };
}
