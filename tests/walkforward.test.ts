import { describe, expect, it } from 'vitest';
import {
  buildWalkForwardWindows,
  enumerateCombos,
  runWalkForward,
  type WalkForwardEvaluation,
  type WalkForwardParams,
} from '../server/optimize/walkforward.js';
import type { DateRange } from '../server/metrics/performance.js';

/** 生成连续的交易日历（YYYYMMDD），跳过周末。 */
function tradingCalendar(count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date('2024-01-01T12:00:00Z');
  while (dates.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const year = cursor.getUTCFullYear();
      const month = String(cursor.getUTCMonth() + 1).padStart(2, '0');
      const day = String(cursor.getUTCDate()).padStart(2, '0');
      dates.push(`${year}${month}${day}`);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** 确定性伪随机噪声（固定种子），用于构造有波动的净值曲线。 */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * 合成评估器：在给定区间上按参数质量生成净值曲线与成交记录。
 *
 * 质量函数：`base = 4 - 2 * |x|`（在 x=0 处平滑取峰），再叠加一个位于
 * x=1.5 的孤立尖峰 —— 这模拟「样本内最优但邻域极差」的过拟合点。
 */
function syntheticEvaluator(calendar: readonly string[]) {
  return (params: WalkForwardParams, range: DateRange): WalkForwardEvaluation => {
    const x = Number(params.x);
    const distance = Math.abs(x);
    let quality = 4 - distance * 2;
    if (x === 1.5) quality += 6; // 孤立尖峰：邻域极差

    const days = calendar.filter((date) => date >= range.start && date <= range.end);
    const used = days.length ? days : calendar.slice(0, 30);
    let total = 100;
    const equityCurve = used.map((date, index) => {
      const dailyReturn = quality / 100 + noise(index + x * 7 + 1) * 0.01;
      total *= 1 + dailyReturn;
      return { date, total: Math.round(total * 10000) / 10000 };
    });

    // 每两日一笔买卖，笔数足够通过统计意义门槛。
    const trades = used
      .filter((_, index) => index % 2 === 0)
      .flatMap((date, index) => ([
        {
          date,
          side: 'buy' as const,
          price: 10,
          shares: 100,
          amount: 1000,
        },
        {
          date,
          side: 'sell' as const,
          price: 10.2,
          shares: 100,
          amount: 1020,
          pnlAmount: quality * 2,
        },
      ]));

    return {
      metrics: {
        annualReturn: quality * 10,
        maxDrawdown: -5,
        sharpe: quality,
        winRate: 60,
        profitFactor: 1.5,
        tradeCount: trades.length / 2,
        turnover: 1,
      },
      trades,
      equityCurve,
    };
  };
}

describe('walk-forward 窗口切分', () => {
  it('按 windowSize 与 stepSize 切分滚动窗口，训练段与验证段不重叠', () => {
    const calendar = tradingCalendar(300);
    const windows = buildWalkForwardWindows(calendar, { windowSize: 100, stepSize: 50 });
    expect(windows).toHaveLength(5);
    expect(windows[0].trainRange.start).toBe(calendar[0]);
    expect(windows[0].trainRange.end).toBe(calendar[69]);
    expect(windows[0].testRange.start).toBe(calendar[70]);
    expect(windows[0].testRange.end).toBe(calendar[99]);
    // 相邻窗口按 stepSize 前进。
    expect(windows[1].trainRange.start).toBe(calendar[50]);
  });

  it('历史长度不足一个窗口时返回空', () => {
    expect(buildWalkForwardWindows(tradingCalendar(50), { windowSize: 100 })).toEqual([]);
  });
});

describe('walk-forward 参数稳定性分析', () => {
  it('在合成数据上定位到已知最优参数区间而非过拟合点', async () => {
    const calendar = tradingCalendar(400);
    const result = await runWalkForward(
      { dimensions: { x: [-2, -1.5, -1, 0, 1, 1.5, 2] } },
      calendar,
      syntheticEvaluator(calendar),
      { windowSize: 100, stepSize: 50, minTradeCount: 1 },
    );
    expect(result.windows.length).toBeGreaterThanOrEqual(4);
    // 样本内最优的孤立尖峰 x=1.5 被判为悬崖型并降权，最优落在平滑峰 x=0。
    expect(result.best!.params.x).toBe(0);
    expect(result.best!.unstable).toBe(false);
    expect(result.best!.stabilityScore).toBeGreaterThan(0);
  });

  it('悬崖型组合被标记为 unstable 并降权', async () => {
    const calendar = tradingCalendar(400);
    const result = await runWalkForward(
      { dimensions: { x: [-2, -1.5, -1, 0, 1, 1.5, 2] } },
      calendar,
      syntheticEvaluator(calendar),
      { windowSize: 100, stepSize: 50, minTradeCount: 1 },
    );
    const cliff = result.candidates.find((item) => Number(item.params.x) === 1.5);
    expect(cliff).toBeDefined();
    expect(cliff!.unstable).toBe(true);
    // 降权后排序分取邻域均值，低于自身样本外夏普。
    expect(cliff!.rankScore).toBe(cliff!.neighborMean);
    expect(cliff!.rankScore).toBeLessThan(cliff!.outOfSample.sharpe);
  });

  it('结果可复现：同一数据与网格两次运行输出完全一致', async () => {
    const calendar = tradingCalendar(300);
    const grid = { dimensions: { x: [-1, 0, 1] } };
    const first = await runWalkForward(grid, calendar, syntheticEvaluator(calendar), {
      windowSize: 100, stepSize: 50, minTradeCount: 1,
    });
    const second = await runWalkForward(grid, calendar, syntheticEvaluator(calendar), {
      windowSize: 100, stepSize: 50, minTradeCount: 1,
    });
    expect(JSON.stringify(second.candidates)).toBe(JSON.stringify(first.candidates));
    expect(JSON.stringify(second.windows)).toBe(JSON.stringify(first.windows));
  });

  it('窗口数不足 4 个时显式提示统计意义有限', async () => {
    const calendar = tradingCalendar(220);
    const result = await runWalkForward(
      { dimensions: { x: [0, 1] } },
      calendar,
      syntheticEvaluator(calendar),
      { windowSize: 100, stepSize: 100, minTradeCount: 1 },
    );
    expect(result.windows).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('统计意义有限');
  });

  it('历史不足以切出窗口时给出提示且不抛异常', async () => {
    const calendar = tradingCalendar(30);
    const result = await runWalkForward(
      { dimensions: { x: [0, 1] } },
      calendar,
      syntheticEvaluator(calendar),
      { windowSize: 100 },
    );
    expect(result.windows).toEqual([]);
    expect(result.best).toBeNull();
    expect(result.warnings.join(' ')).toContain('无法执行 walk-forward');
  });

  it('报告按排序分降序排列并包含窗口明细与样本内外指标', async () => {
    const calendar = tradingCalendar(300);
    const result = await runWalkForward(
      { dimensions: { x: [-1, 0, 1] } },
      calendar,
      syntheticEvaluator(calendar),
      { windowSize: 100, stepSize: 50, minTradeCount: 1 },
    );
    for (let index = 1; index < result.candidates.length; index += 1) {
      expect(result.candidates[index - 1].rankScore).toBeGreaterThanOrEqual(result.candidates[index].rankScore);
    }
    for (const window of result.windows) {
      expect(window.trainRange.start < window.trainRange.end).toBe(true);
      expect(window.testRange.start > window.trainRange.end).toBe(true);
      expect(window.testMetrics).toBeDefined();
      expect(window.evaluatedCombos).toBe(3);
    }
    expect(result.aggregate.tradeCount).toBeGreaterThan(0);
  });

  it('网格枚举顺序固定，可复现', () => {
    const combos = enumerateCombos({ dimensions: { a: [1, 2], b: [10] } });
    expect(combos).toEqual([{ a: 1, b: 10 }, { a: 2, b: 10 }]);
  });
});
