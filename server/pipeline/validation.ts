/**
 * 验证报告（P5）。
 *
 * 把「样本外预测」与「模拟实盘实测」逐项对比：
 * - **预测**来自挖掘批次的样本外指标（`MiningResult.outOfSample`）；
 * - **实测**来自该下发实例自己的模拟成交，复用 P1 的统一指标口径
 *   （`fromPaperInstructions` + `paperPnlBySellInstruction` + `computeMetrics`），
 *   本文件不另写指标实现。
 *
 * 偏差超过阈值（默认 30%）的指标标红，并列出可能原因（滑点 / 流动性 / 信号延迟）。
 */

import { round } from '../format.js';
import { computeMetrics, type PerformanceMetrics } from '../metrics/performance.js';
import { fromPaperInstructions, paperPnlBySellInstruction } from '../metrics/adapters.js';
import type { PaperStrategyInstruction } from '../../src/types.js';
import type { MiningInstanceConfig } from './deploy.js';
import type { FrictionStats } from './friction.js';

export interface ValidationMetricComparison {
  key: 'annualReturn' | 'maxDrawdown' | 'winRate' | 'tradeFrequency';
  label: string;
  predicted: number;
  actual: number;
  /** 相对偏差 = |actual - predicted| / max(|predicted|, 1e-6)。 */
  deviation: number;
  /** 偏差超阈值 → 报告标红。 */
  exceeded: boolean;
}

export interface ValidationReport {
  instanceId: string;
  runId: string;
  rank: number;
  createdAt: string;
  status: 'pass' | 'deviated';
  comparisons: ValidationMetricComparison[];
  friction: FrictionStats;
  /** 可能原因：滑点 / 流动性 / 信号延迟 / 样本不足。 */
  possibleCauses: string[];
  warnings: string[];
}

/** 偏差阈值：超过即标红。 */
export const DEFAULT_DEVIATION_THRESHOLD = 0.3;

/** 交易笔数低于该值时提示「样本量不足」。 */
export const MIN_MEANINGFUL_TRADE_COUNT = 20;

/** 回测默认滑点率；实测滑点高于它即视为「高于回测假设」。 */
const DEFAULT_SLIPPAGE_ASSUMPTION = 0.0005;

function deviationOf(predicted: number, actual: number): number {
  return Math.abs(actual - predicted) / Math.max(Math.abs(predicted), 1e-6);
}

/**
 * 由模拟成交指令计算实测指标。
 *
 * 实测交易笔数与「笔/日」频率的分母（实际交易日数）由调用方给出 ——
 * 样本外的预测频率是「笔/样本外交易日」，实测频率必须用同一量纲才能比。
 */
export function computeActualMetrics(
  instructions: readonly PaperStrategyInstruction[],
  actualTradingDays: number,
): PerformanceMetrics {
  const pnlBySell = paperPnlBySellInstruction(instructions);
  const trades = fromPaperInstructions(
    instructions,
    (instruction) => pnlBySell.get(instruction.id),
  );
  return computeMetrics({ trades, initialCapital: 100_000 });
}

/**
 * 生成验证报告。
 */
export function buildValidationReport(input: {
  config: MiningInstanceConfig;
  /** 样本外预测指标。 */
  predicted: PerformanceMetrics;
  /** 样本外交易日数（预测频率的分母）。 */
  predictedOutOfSampleDays: number;
  /** 实测指标。 */
  actual: PerformanceMetrics;
  /** 实测交易日数（实测频率的分母）。 */
  actualTradingDays: number;
  friction: FrictionStats;
  threshold?: number;
  now?: () => Date;
}): ValidationReport {
  const threshold = input.threshold ?? DEFAULT_DEVIATION_THRESHOLD;
  const predictedFrequency = input.predictedOutOfSampleDays > 0
    ? input.predicted.tradeCount / input.predictedOutOfSampleDays
    : 0;
  const actualFrequency = input.actualTradingDays > 0
    ? input.actual.tradeCount / input.actualTradingDays
    : 0;

  const comparisons: ValidationMetricComparison[] = [
    {
      key: 'annualReturn',
      label: '年化收益（%）',
      predicted: round(input.predicted.annualReturn, 4),
      actual: round(input.actual.annualReturn, 4),
      deviation: 0,
      exceeded: false,
    },
    {
      key: 'maxDrawdown',
      label: '最大回撤（%）',
      predicted: round(input.predicted.maxDrawdown, 4),
      actual: round(input.actual.maxDrawdown, 4),
      deviation: 0,
      exceeded: false,
    },
    {
      key: 'winRate',
      label: '胜率（%）',
      predicted: round(input.predicted.winRate, 4),
      actual: round(input.actual.winRate, 4),
      deviation: 0,
      exceeded: false,
    },
    {
      key: 'tradeFrequency',
      label: '交易频率（笔/日）',
      predicted: round(predictedFrequency, 4),
      actual: round(actualFrequency, 4),
      deviation: 0,
      exceeded: false,
    },
  ];
  for (const comparison of comparisons) {
    comparison.deviation = round(deviationOf(comparison.predicted, comparison.actual), 4);
    comparison.exceeded = comparison.deviation > threshold;
  }

  const possibleCauses: string[] = [];
  const warnings: string[] = [];

  if (input.friction.avgSlippageRate > DEFAULT_SLIPPAGE_ASSUMPTION) {
    possibleCauses.push(
      `滑点高于回测假设（实测 ${(input.friction.avgSlippageRate * 100).toFixed(3)}% vs 假设 ${(DEFAULT_SLIPPAGE_ASSUMPTION * 100).toFixed(3)}%），侵蚀收益`,
    );
  }
  if (input.friction.unfilledRate > 0.1 || input.friction.cancelRate > 0.1) {
    possibleCauses.push(
      `流动性不足：未成交率 ${(input.friction.unfilledRate * 100).toFixed(1)}%、撤单率 ${(input.friction.cancelRate * 100).toFixed(1)}%`,
    );
  }
  const frequencyComparison = comparisons.find((item) => item.key === 'tradeFrequency')!;
  if (frequencyComparison.actual < frequencyComparison.predicted * 0.7) {
    possibleCauses.push('实际交易频率明显低于样本外预测：可能是信号延迟或部分信号未触发');
  }
  if (input.predicted.tradeCount < MIN_MEANINGFUL_TRADE_COUNT
    || input.actual.tradeCount < MIN_MEANINGFUL_TRADE_COUNT) {
    warnings.push('样本量不足，指标参考意义有限');
  }
  if (!input.actual.tradeCount) {
    warnings.push('实例尚无成交记录，无法给出实测指标');
  }

  return {
    instanceId: input.config.instanceId,
    runId: input.config.sourceRunId,
    rank: input.config.sourceRank,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    status: comparisons.some((item) => item.exceeded) ? 'deviated' : 'pass',
    comparisons,
    friction: input.friction,
    possibleCauses,
    warnings,
  };
}
