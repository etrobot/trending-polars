import { describe, expect, it } from 'vitest';
import {
  defaultRankingRuntimeConfig,
  normalizeRankingRuntimeConfig,
} from '../server/ranking-config.js';
import {
  DEFAULT_FACTOR_WEIGHTS,
  MAX_FACTOR_WEIGHT_PCT,
  MIN_FACTOR_WEIGHT_PCT,
} from '../server/backtest-engine.js';
import { DEFAULT_SCORE_STOCK_CONFIG } from '../server/scoring-engine.js';

describe('normalizeRankingRuntimeConfig', () => {
  it('produces a full config when called with no input', () => {
    const config = normalizeRankingRuntimeConfig();
    expect(config.factor_weights).toEqual({ ...DEFAULT_FACTOR_WEIGHTS });
    expect(config.scoring_config.relativeStrength.lookback).toBe(20);
    expect(config.scoring_config.marketState).toEqual(DEFAULT_SCORE_STOCK_CONFIG.marketState);
  });

  it('matches defaultRankingRuntimeConfig for the scoring fields', () => {
    const normalized = normalizeRankingRuntimeConfig();
    const defaulted = defaultRankingRuntimeConfig('2026-07-27 00:00:00');
    expect(normalized.scoring_config).toEqual(defaulted.scoring_config);
  });

  it('fills in the missing relativeStrength / marketState / relativeStrengthWeightPct fields from a stale config', () => {
    // 模拟早期版本写入的 ranking-config.json：scoring_config 缺 relativeStrength/marketState，
    // factor_weights 缺 relativeStrengthWeightPct。直接打分会在 relativeStrength.lookback 处崩溃。
    const stale = {
      factor_weights: {
        trendWeightPct: 70,
        volumePriceWeightPct: 100,
        distanceFromLowWeightPct: 85,
        volatilityTrendWeightPct: 100,
      },
      scoring_config: {
        distanceFromLow: { ...DEFAULT_SCORE_STOCK_CONFIG.distanceFromLow },
        trend: { ...DEFAULT_SCORE_STOCK_CONFIG.trend },
        volatilityTrend: { ...DEFAULT_SCORE_STOCK_CONFIG.volatilityTrend },
      },
      applied_backtest_run_id: '20260726_120503',
      updated_at: '2026-07-26 13:00:26',
    };

    const normalized = normalizeRankingRuntimeConfig(stale);

    // 用户自定义的覆盖被保留。
    expect(normalized.factor_weights.trendWeightPct).toBe(70);
    expect(normalized.factor_weights.distanceFromLowWeightPct).toBe(85);
    expect(normalized.applied_backtest_run_id).toBe('20260726_120503');
    expect(normalized.updated_at).toBe('2026-07-26 13:00:26');

    // 缺失字段被默认值补齐 —— 这是修复 "Cannot read properties of undefined (reading 'lookback')" 的关键。
    expect(normalized.factor_weights.relativeStrengthWeightPct).toBe(100);
    expect(normalized.scoring_config.relativeStrength).toEqual(DEFAULT_SCORE_STOCK_CONFIG.relativeStrength);
    expect(normalized.scoring_config.relativeStrength.lookback).toBe(20);
    expect(normalized.scoring_config.marketState).toEqual(DEFAULT_SCORE_STOCK_CONFIG.marketState);
  });

  it('preserves explicit overrides for relativeStrength/marketState', () => {
    const normalized = normalizeRankingRuntimeConfig({
      scoring_config: {
        relativeStrength: { lookback: 10, floorPct: -10, capPct: 20, maxScore: 15 },
      } as never,
    });
    expect(normalized.scoring_config.relativeStrength.lookback).toBe(10);
    expect(normalized.scoring_config.relativeStrength.floorPct).toBe(-10);
    expect(normalized.scoring_config.relativeStrength.maxScore).toBe(15);
    // 未覆盖的整段字段回退到默认值（marketState 未提供）。
    expect(normalized.scoring_config.marketState).toEqual(DEFAULT_SCORE_STOCK_CONFIG.marketState);
  });

  it('accepts factor boosts above 100% and clamps only at the shared limits', () => {
    const normalized = normalizeRankingRuntimeConfig({
      factor_weights: {
        trendWeightPct: 250,
        volumePriceWeightPct: 150,
        distanceFromLowWeightPct: 0,
        volatilityTrendWeightPct: 175,
        relativeStrengthWeightPct: -20,
      },
    });

    expect(normalized.factor_weights).toEqual({
      trendWeightPct: MAX_FACTOR_WEIGHT_PCT,
      volumePriceWeightPct: 150,
      distanceFromLowWeightPct: MIN_FACTOR_WEIGHT_PCT,
      volatilityTrendWeightPct: 175,
      relativeStrengthWeightPct: MIN_FACTOR_WEIGHT_PCT,
    });
  });
});
