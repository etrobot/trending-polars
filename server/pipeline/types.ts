/**
 * 挖掘流水线的落库结构（P4）。
 *
 * 约定：
 * - `runId` 是全局唯一标识，贯穿「挖掘 → 报告 → 模拟交易下发 → 验证报告」，
 *   与审计日志使用同一标识体系（P5 依赖这一点）。
 * - `codeVersion` / `dataVersion` 让每次运行可被还原：代码版本是 git commit，
 *   数据版本是「最后交易日 + 校验摘要」。
 * - 落库文件放在独立目录（`server/data/mining`），不进入交易链路。
 */

import type { PerformanceMetrics } from '../metrics/performance.js';
import type { FrictionCalibration } from './friction.js';

/** 数据质量检查结果。 */
export interface DataQualityGaps {
  /** 行情不连续的标的：缺失的交易日。 */
  priceGaps: Array<{ stock_code: string; missing_dates: string[] }>;
  /** 除权（复权）标记相关问题。 */
  adjustmentIssues: string[];
  /** 缺少涨停记录的交易日。 */
  limitUpMissingDates: string[];
}

export interface DataQualityReport {
  /** 是否通过质量门槛。 */
  ok: boolean;
  /** 数据截止交易日。 */
  asOfDate: string;
  /** 标的池规模。 */
  universeSize: number;
  /** 实际有行情的标的数。 */
  coveredStocks: number;
  /** 行情连续性覆盖率（0-1）。 */
  priceCoverageRatio: number;
  /** 涨停记录覆盖率（0-1）。 */
  limitUpCoverageRatio: number;
  /** 行情是否为前复权。 */
  adjusted: boolean;
  /** 缺失明细（不静默跳过）。 */
  gaps: DataQualityGaps;
  /** 未通过的原因。 */
  reasons: string[];
}

/** 一次挖掘运行。 */
export interface MiningRun {
  runId: string;
  createdAt: string;
  /** git commit hash。 */
  codeVersion: string;
  /** 数据快照标识（最后交易日 + 校验摘要）。 */
  dataVersion: string;
  /** 标的池。 */
  universe: string[];
  /** 启用子策略（来自 P2 注册表）。 */
  strategies: string[];
  /** 完整配置：窗口、网格、过滤参数。 */
  config: Record<string, unknown>;
  status: 'success' | 'failed';
  error?: string;
  /** 数据质量报告（缺口显式列出）。 */
  quality?: DataQualityReport;
}

/** 一条候选参数结果。 */
export interface MiningResult {
  runId: string;
  params: Record<string, number>;
  inSample: PerformanceMetrics;
  outOfSample: PerformanceMetrics;
  stabilityScore: number;
  /** 样本外已平仓交易笔数。 */
  tradeCount: number;
  /** 排名（1 起始）。 */
  rank: number;
  /** 悬崖型组合（不稳定，已降权）。 */
  unstable?: boolean;
  /** P5：样本外交易日数（用于计算「笔/日」交易频率预测值）。 */
  outOfSampleDays: number;
  /** P5：样本外区间。 */
  outOfSampleRange?: { start: string; end: string };
}

/** 报告（JSON 形态，HTML 报告由同一份数据渲染）。 */
export interface MiningReport {
  runId: string;
  createdAt: string;
  codeVersion: string;
  dataVersion: string;
  universe: string[];
  strategies: string[];
  quality: DataQualityReport;
  warnings: string[];
  /** 参数轨迹的样本外整体指标。 */
  aggregate: PerformanceMetrics;
  results: MiningResult[];
  /** P5：本轮使用的实测摩擦校准（缺省表示沿用默认滑点）。 */
  calibration?: FrictionCalibration;
}
