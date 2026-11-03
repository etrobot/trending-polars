/**
 * Walk-forward 与回测引擎的接线层（P3）。
 *
 * optimize/walkforward.ts 只负责窗口切分、选参与稳定性分析，不关心回测怎么跑；
 * 本文件提供「参数组合 → 回测 → 统一指标」的求值器，并把参数网格翻译成
 * backtest-engine 的快速模拟入参。
 */

import {
  prepareBacktestContext,
  quickSimulateBacktestFull,
  sliceBacktestContext,
} from '../backtest-engine.js';
import { fromBacktestEquity, fromBacktestTrades } from '../metrics/adapters.js';
import type { DateRange } from '../metrics/performance.js';
import type { HistoricalMarketData } from '../historical-market.js';
import { normalizeBacktestDays } from '../historical-market.js';
import {
  DEFAULT_WALKFORWARD_WINDOW_SIZE,
  DEFAULT_WALKFORWARD_STEP_SIZE,
  runWalkForward,
  type WalkForwardGrid,
  type WalkForwardOptions,
  type WalkForwardResult,
} from './walkforward.js';

/** 可被 walk-forward 搜索的回测参数维度。 */
export interface WalkForwardBacktestParams {
  maxHoldDays: number;
  maxPositions?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  positionSizePct?: number;
  trendWeightPct?: number;
  volumePriceWeightPct?: number;
  distanceFromLowWeightPct?: number;
  volatilityWeightPct?: number;
  relativeStrengthWeightPct?: number;
  /** P5：实测滑点率（0-1），缺省用回测默认值。 */
  slippageRate?: number;
}

/**
 * 默认网格：围绕当前策略默认值做小范围扰动。
 *
 * 取值刻意保持「每维 3 档」，使邻域（±1 步）有足够样本、又不会把搜索空间
 * 放大到不可接受；权重维度只取 100 以外的两档，避免与评分归一化耦合后
 * 出现「改权重同时改入场松紧」的混淆（与 backtest-param-optimizer 的约束一致）。
 */
export const DEFAULT_WALKFORWARD_GRID: WalkForwardGrid = {
  dimensions: {
    maxHoldDays: [3, 5, 7, 10],
    takeProfitPct: [10, 15, 20, 25],
    stopLossPct: [-5, -8, -12],
  },
};

/**
 * 在真实回测上执行 walk-forward。
 *
 * 每个窗口的求值方式：把回测上下文裁剪到窗口区间后独立运行（仓位从空仓开始），
 * 再按训练段 / 验证段把成交与净值切开计算指标 —— 这样同一窗口内的训练段与
 * 验证段共享同一条资金曲线，切分口径与 P1 的样本内外切分一致。
 */
export async function runBacktestWalkForward(
  history: HistoricalMarketData,
  options: WalkForwardOptions & {
    days?: number;
    grid?: WalkForwardGrid;
    baseParams?: WalkForwardBacktestParams;
  } = {},
): Promise<WalkForwardResult> {
  const days = normalizeBacktestDays(options.days, 20);
  const context = prepareBacktestContext(history, days);
  const calendar = context.dates;
  const baseParams: WalkForwardBacktestParams = {
    maxHoldDays: 5,
    ...(options.baseParams ?? {}),
  };
  const grid = options.grid ?? DEFAULT_WALKFORWARD_GRID;

  const evaluator = async (
    params: Record<string, number>,
    range: DateRange,
  ) => {
    const merged = { ...baseParams, ...params } as WalkForwardBacktestParams;
    const windowContext = sliceBacktestContext(context, range);
    const simulation = quickSimulateBacktestFull(windowContext, merged);
    return {
      metrics: simulation.summary.metrics,
      trades: fromBacktestTrades(simulation.trades),
      equityCurve: fromBacktestEquity(simulation.equityCurve),
    };
  };

  return runWalkForward(grid, calendar, evaluator, {
    windowSize: options.windowSize ?? DEFAULT_WALKFORWARD_WINDOW_SIZE,
    stepSize: options.stepSize ?? DEFAULT_WALKFORWARD_STEP_SIZE,
    trainRatio: options.trainRatio,
    minTradeCount: options.minTradeCount,
    cliffThreshold: options.cliffThreshold,
    randomSeed: options.randomSeed,
    initialCapital: options.initialCapital,
    concurrency: options.concurrency,
  });
}
