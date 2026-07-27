import { describe, expect, it } from 'vitest';
import { computeFactorIC, spearman } from '../server/factor-ic.js';
import type { HistoricalBar, HistoricalMarketData } from '../server/historical-market.js';
import { historicalFixture } from './historical-fixture.js';

/**
 * IC 需要一个真实宽度的截面（historicalFixture 只有 4 只股票，算不出有意义的秩相关）。
 * 这里按确定性伪随机生成 14 只股票，收益结构各不相同。
 */
function wideHistory(stockCount = 14): HistoricalMarketData {
  const base = historicalFixture();
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const stocks = Array.from({ length: stockCount }, (_, index) => {
    const drift = (index - stockCount / 2) * 0.0012;
    let close = 10 + index;
    const bars: HistoricalBar[] = base.calendar.map((date) => {
      const change = drift + (rnd() - 0.5) * 0.03;
      const open = close;
      close = Math.max(1, close * (1 + change));
      const volume = Math.round(5_000_000 * (0.7 + rnd() * 0.8));
      return [
        date,
        Number(open.toFixed(3)),
        Number(close.toFixed(3)),
        Number((Math.max(open, close) * 1.01).toFixed(3)),
        Number((Math.min(open, close) * 0.99).toFixed(3)),
        volume,
        Number((volume * close).toFixed(2)),
        Number((change * 100).toFixed(2)),
      ];
    });
    return {
      stock_code: String(600100 + index),
      stock_name: `IC样本${index}`,
      bars,
    };
  });
  return { ...base, stocks };
}

describe('spearman — 秩相关', () => {
  it('returns 1 for a perfectly monotone relationship regardless of scale', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 200, 3000, 40000, 500000])).toBeCloseTo(1, 6);
  });

  it('returns -1 when the ranking is exactly reversed', () => {
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 6);
  });

  it('averages tied ranks instead of using arbitrary order', () => {
    // [1,1,2,2] 的秩应为 [1.5,1.5,3.5,3.5]；与 [3,1,2,4] 的秩相关恰为 2/sqrt(20)。
    expect(spearman([1, 1, 2, 2], [3, 1, 2, 4])).toBeCloseTo(2 / Math.sqrt(20), 6);
    // 同时反转两个序列不应改变秩相关。
    expect(spearman([2, 2, 1, 1], [4, 2, 1, 3])).toBeCloseTo(spearman([1, 1, 2, 2], [3, 1, 2, 4]), 6);
  });

  it('is zero for degenerate input', () => {
    expect(spearman([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
    expect(spearman([1, 2], [1, 2])).toBe(0);
  });
});

describe('computeFactorIC — 因子有效性面板', () => {
  it('reports IC, ICIR and layered returns for every dimension', () => {
    const report = computeFactorIC(wideHistory(), 40, 5);
    const keys = report.factors.map((factor) => factor.key);
    expect(keys).toContain('trend_score');
    expect(keys).toContain('volume_price_score');
    expect(keys).toContain('position_score');
    expect(keys).toContain('volatility_trend_score');
    expect(keys).toContain('relative_strength_score');
    expect(keys).toContain('total_score');

    for (const factor of report.factors) {
      expect(factor.sampleDays).toBeGreaterThan(0);
      expect(factor.meanIC).toBeGreaterThanOrEqual(-1);
      expect(factor.meanIC).toBeLessThanOrEqual(1);
      expect(factor.positiveRatio).toBeGreaterThanOrEqual(0);
      expect(factor.positiveRatio).toBeLessThanOrEqual(100);
      expect(factor.quintileReturns).toHaveLength(5);
      expect(Number.isFinite(factor.icir)).toBe(true);
      expect(Number.isFinite(factor.tStat)).toBe(true);
    }
    expect(report.forwardDays).toBe(5);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('emits a pairwise correlation matrix excluding the derived total', () => {
    const report = computeFactorIC(wideHistory(), 40, 5);
    // total_score 是其余各维的线性组合，纳入相关矩阵没有意义。
    for (const pair of report.correlations) {
      expect(pair.a).not.toBe('total_score');
      expect(pair.b).not.toBe('total_score');
      expect(pair.correlation).toBeGreaterThanOrEqual(-1);
      expect(pair.correlation).toBeLessThanOrEqual(1);
    }
    // 5 个维度两两配对 = 10 组
    expect(report.correlations).toHaveLength(10);
  });

  it('never reads beyond the requested window', () => {
    const history = wideHistory();
    const report = computeFactorIC(history, 30, 5);
    const [start, end] = report.dateRange.split(' ~ ');
    expect(history.calendar).toContain(start);
    expect(end <= history.as_of_date).toBe(true);
  });

  it('refuses a window too short to form a forward return', () => {
    const history = wideHistory();
    expect(() => computeFactorIC({ ...history, calendar: history.calendar.slice(-3) }, 10, 5))
      .toThrow(/至少需要/);
  });
});
