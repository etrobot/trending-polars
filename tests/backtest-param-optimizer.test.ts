import { describe, expect, it } from 'vitest';
import { runPolarsBacktest } from '../server/backtest-engine.js';
import { optimizeStrategyParams } from '../server/backtest-param-optimizer.js';
import { historicalFixture } from './historical-fixture.js';

describe('backtest param optimizer', () => {
  it('optimizes against forward returns and reproduces its full backtest validation', () => {
    const fixture = historicalFixture();
    const result = optimizeStrategyParams(fixture, { days: 20 });
    expect(result.days).toBe(20);
    expect(result).not.toHaveProperty('topN');
    expect(result.scoring.scoreCorrelation).toBeGreaterThanOrEqual(-1);
    expect(result.scoring.scoreCorrelation).toBeLessThanOrEqual(1);
    expect(Number.isFinite(result.scoring.topBottomSpreadPct)).toBe(true);
    expect(result.scoring.distanceBucketStats.length).toBeGreaterThan(0);
    expect(result.scoring.distanceBucketStats[0]).toMatchObject({
      sampleCount: expect.any(Number),
      avgForwardReturnPct: expect.any(Number),
      winRatePct: expect.any(Number),
      positionScore: expect.any(Number),
    });
    expect(result.baseline.validation.totalReturnPct).toBeDefined();
    expect(result.validation.totalReturnPct).toBeDefined();
    expect(result.validation.totalReturnPct).toBeGreaterThanOrEqual(result.baseline.validation.totalReturnPct);
    expect(typeof result.beatBaseline).toBe('boolean');
    if (!result.beatBaseline) {
      expect(result.validation.totalReturnPct).toBe(result.baseline.validation.totalReturnPct);
      expect(result.methodology).toContain('回退默认');
    } else {
      expect(result.validation.totalReturnPct).toBeGreaterThan(result.baseline.validation.totalReturnPct);
      expect(result.methodology).toContain('超越默认基线');
    }

    const params = result.optimized;
    const rerun = runPolarsBacktest(fixture, {
      days: result.days,
      maxHoldDays: params.maxHoldDays,
      maxPositions: params.maxPositions,
      positionSizePct: params.positionSizePct,
      takeProfitPct: params.takeProfitPct,
      stopLossPct: params.stopLossPct,
      trendWeightPct: params.trendWeightPct,
      volumePriceWeightPct: params.volumePriceWeightPct,
      distanceFromLowWeightPct: params.distanceFromLowWeightPct,
      volatilityTrendWeightPct: params.volatilityWeightPct,
      relativeStrengthWeightPct: params.relativeStrengthWeightPct,
      scoringConfig: result.scoring.config,
    });
    expect(rerun.summary.total_return_pct).toBe(result.validation.totalReturnPct);
    expect(rerun.summary.win_rate).toBe(result.validation.winRate);
    expect(rerun.summary.max_drawdown_pct).toBe(result.validation.maxDrawdownPct);
    expect(rerun.summary.total_trades).toBe(result.validation.totalTrades);
  }, 30_000);

  it('rejects when sample size is insufficient', () => {
    const fixture = historicalFixture();
    // days=6 仅剩 1 个可评估截面（4 条观测），低于 10 条下限。
    expect(() => optimizeStrategyParams(fixture, { days: 6 })).toThrow(/样本不足/);
  });
});
