import {
  DEFAULT_FACTOR_WEIGHTS,
  normalizeFactorWeights,
  type FactorWeights,
} from './backtest-engine.js';
import { formatDateTime } from './format.js';
import {
  DEFAULT_SCORE_STOCK_CONFIG,
  normalizeScoreStockConfig,
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
