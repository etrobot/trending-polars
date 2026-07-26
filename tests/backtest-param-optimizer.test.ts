import { describe, expect, it } from 'vitest';
import { optimizeStrategyParams } from '../server/backtest-param-optimizer.js';
import { historicalFixture } from './historical-fixture.js';

describe('backtest param optimizer', () => {
  it('optimizes against full backtest objective and includes baseline comparison', async () => {
    const fixture = historicalFixture();
    const result = optimizeStrategyParams(fixture, { days: 20 });
    expect(result.days).toBe(20);
    expect(result.baseline.validation.totalReturnPct).toBeDefined();
    expect(result.validation.totalReturnPct).toBeDefined();
    expect(typeof result.beatBaseline).toBe('boolean');
    if (!result.beatBaseline) {
      expect(result.validation.totalReturnPct).toBe(result.baseline.validation.totalReturnPct);
      expect(result.methodology).toContain('回退默认');
    } else {
      expect(result.methodology).toContain('超越默认基线');
    }
  }, 30_000);

  it('clamps days to minimum 5 and still produces a result', () => {
    const fixture = historicalFixture();
    const result = optimizeStrategyParams(fixture, { days: 2 });
    expect(result.days).toBe(5); // clamped to min 5
    expect(result.validation.totalReturnPct).toBeDefined();
  });
});
