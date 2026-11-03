/**
 * 成交摩擦统计（P5）。
 *
 * 从模拟交易的委托记录里还原三类真实摩擦：
 * - **滑点**：成交价 vs 信号生成时的价格。买入以「成交价高于信号价」为不利方向，
 *   卖出以「成交价低于信号价」为不利方向，统一折算成「不利滑点率」（正数表示吃亏）。
 * - **未成交率**：已提交到券商但最终没成交（过期/废单）的比例。
 * - **撤单率**：已提交后被撤掉的比例。
 *
 * 这三项会回写为校准数据，供下一轮挖掘（P3/P4）读取。
 */

import type { PaperStrategyInstruction } from '../../src/types.js';

export interface FrictionStats {
  /** 参与统计的委托数（已提交到券商的）。 */
  attempted: number;
  /** 成交笔数。 */
  filled: number;
  /** 未成交笔数（过期/废单）。 */
  unfilled: number;
  /** 撤单笔数。 */
  cancelled: number;
  /** 未成交率（0-1）。 */
  unfilledRate: number;
  /** 撤单率（0-1）。 */
  cancelRate: number;
  /** 成交率（0-1）。 */
  fillRate: number;
  /** 有可比价格的成交样本数。 */
  slippageSamples: number;
  /** 平均不利滑点率（0-1），正数表示比信号价更差。 */
  avgSlippageRate: number;
  /** 最大不利滑点率（0-1）。 */
  maxSlippageRate: number;
  /** 平均不利滑点（百分点）。 */
  avgSlippagePct: number;
  /** 最大不利滑点（百分点）。 */
  maxSlippagePct: number;
}

/** 已实际提交到券商的状态；pending/skipped 从未出手，不计入分母。 */
const ATTEMPTED_STATUSES = new Set(['submitted', 'filled', 'expired', 'failed', 'cancelled', 'uncertain']);
const UNFILLED_STATUSES = new Set(['expired', 'failed']);

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/**
 * 计算摩擦统计。
 */
export function computeFrictionStats(
  instructions: readonly PaperStrategyInstruction[],
): FrictionStats {
  const attemptedInstructions = instructions.filter((instruction) => ATTEMPTED_STATUSES.has(instruction.status));
  const filled = attemptedInstructions.filter((instruction) => instruction.status === 'filled');
  const unfilled = attemptedInstructions.filter((instruction) => UNFILLED_STATUSES.has(instruction.status));
  const cancelled = attemptedInstructions.filter((instruction) => instruction.status === 'cancelled');

  const slippageRates: number[] = [];
  for (const instruction of filled) {
    const signalPrice = Number(instruction.signal_price ?? 0);
    const executionPrice = Number(instruction.execution_price ?? 0);
    if (!Number.isFinite(signalPrice) || !Number.isFinite(executionPrice) || signalPrice <= 0) continue;
    const adverse = instruction.side === 'buy'
      ? (executionPrice - signalPrice) / signalPrice
      : (signalPrice - executionPrice) / signalPrice;
    slippageRates.push(adverse);
  }

  const attempted = attemptedInstructions.length;
  const avgSlippageRate = slippageRates.length
    ? slippageRates.reduce((sum, value) => sum + value, 0) / slippageRates.length
    : 0;
  const maxSlippageRate = slippageRates.length ? Math.max(...slippageRates) : 0;

  return {
    attempted,
    filled: filled.length,
    unfilled: unfilled.length,
    cancelled: cancelled.length,
    unfilledRate: attempted ? round4(unfilled.length / attempted) : 0,
    cancelRate: attempted ? round4(cancelled.length / attempted) : 0,
    fillRate: attempted ? round4(filled.length / attempted) : 0,
    slippageSamples: slippageRates.length,
    avgSlippageRate: round4(avgSlippageRate),
    maxSlippageRate: round4(maxSlippageRate),
    avgSlippagePct: round4(avgSlippageRate * 100),
    maxSlippagePct: round4(maxSlippageRate * 100),
  };
}

/**
 * 校准数据（P3/P4 读取）。
 *
 * 下一轮挖掘用 `slippageRate` 覆盖回测里的默认滑点，
 * 使样本外评估口径贴近实测。
 */
export interface FrictionCalibration {
  runId: string;
  createdAt: string;
  /** 实测平均不利滑点率（0-1）。 */
  slippageRate: number;
  /** 实测未成交率（0-1）。 */
  unfilledRate: number;
  /** 实测撤单率（0-1）。 */
  cancelRate: number;
  /** 样本量（成交笔数）。 */
  sampleSize: number;
}

/**
 * 由摩擦统计生成校准数据。
 *
 * 样本量不足时返回 null —— 用两三笔成交推导出的滑点没有意义，
 * 不如让下一轮挖掘继续沿用默认滑点。
 */
export function calibrationFromFriction(
  runId: string,
  createdAt: string,
  friction: FrictionStats,
  minSamples = 5,
): FrictionCalibration | null {
  if (friction.slippageSamples < minSamples) return null;
  return {
    runId,
    createdAt,
    slippageRate: friction.avgSlippageRate,
    unfilledRate: friction.unfilledRate,
    cancelRate: friction.cancelRate,
    sampleSize: friction.slippageSamples,
  };
}
