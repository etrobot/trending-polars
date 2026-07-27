import {
  DEFAULT_FACTOR_WEIGHTS,
  normalizeFactorWeights,
  type FactorWeights,
} from './backtest-engine.js';
import { formatDateTime } from './format.js';
import {
  DEFAULT_SCORE_STOCK_CONFIG,
  normalizeScoreStockConfig,
  type DeepPartial,
  type ScoreStockConfig,
} from './scoring-engine.js';

export interface RankingRuntimeConfig {
  factor_weights: FactorWeights;
  scoring_config: ScoreStockConfig;
  applied_backtest_run_id?: string;
  updated_at: string;
}

export function factorWeightsFromBacktestConfig(
  config: Record<string, number | string | null | undefined>,
): FactorWeights {
  return normalizeFactorWeights({
    trendWeightPct: Number(config.trend_weight_pct),
    volumePriceWeightPct: Number(config.volume_price_weight_pct),
    distanceFromLowWeightPct: Number(config.distance_from_low_weight_pct),
    volatilityTrendWeightPct: Number(config.volatility_weight_pct),
    relativeStrengthWeightPct: Number(config.relative_strength_weight_pct),
  });
}

export function scoringConfigFromBacktestConfig(
  config: Record<string, number | string | null | undefined>,
): ScoreStockConfig {
  const raw = config.scoring_config_json;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return normalizeScoreStockConfig(JSON.parse(raw) as Parameters<typeof normalizeScoreStockConfig>[0]);
    } catch (error) {
      console.warn('[ranking-config] failed to parse scoring_config_json', error);
    }
  }
  return DEFAULT_SCORE_STOCK_CONFIG;
}

export function rankingConfigFromBacktest(
  runId: string,
  config: Record<string, number | string | null | undefined>,
  timestamp: string = formatDateTime(),
): RankingRuntimeConfig {
  return {
    factor_weights: factorWeightsFromBacktestConfig(config),
    scoring_config: scoringConfigFromBacktestConfig(config),
    applied_backtest_run_id: runId,
    updated_at: timestamp,
  };
}

export function defaultRankingRuntimeConfig(timestamp: string = formatDateTime()): RankingRuntimeConfig {
  return {
    factor_weights: { ...DEFAULT_FACTOR_WEIGHTS },
    scoring_config: normalizeScoreStockConfig(),
    updated_at: timestamp,
  };
}

/**
 * 将磁盘上读取的 ranking-config 与默认值合并，补齐历史版本缺失的字段。
 *
 * ranking-config.json 可能是早期版本写入的（例如相对强度 `relativeStrength`、
 * 八态阈值 `marketState`、以及 `relativeStrengthWeightPct` 还未加入之前），
 * 直接拿原始 JSON 去打分会在 `scoringConfig.relativeStrength.lookback` 处抛
 * "Cannot read properties of undefined"。这里在读取时统一与默认值对齐，既保留
 * 用户自定义的覆盖、又保证所有维度字段一定存在。
 */
export function normalizeRankingRuntimeConfig(config?: DeepPartial<RankingRuntimeConfig> | null): RankingRuntimeConfig {
  const timestamp = config?.updated_at ?? formatDateTime();
  return {
    factor_weights: normalizeFactorWeights(config?.factor_weights),
    scoring_config: normalizeScoreStockConfig(config?.scoring_config),
    applied_backtest_run_id: config?.applied_backtest_run_id ?? undefined,
    updated_at: timestamp,
  };
}
