/**
 * 策略挖掘流水线（P4）。
 *
 * 按顺序执行四个环节，任一环节失败即中止并记录：
 * 1. **数据检查与补齐**：由调用方注入的 `prepareData` 完成（沿用既有增量补采逻辑，
 *    不做区间整体跳过）；本环节之后立刻跑数据质量检查，缺口超阈值则运行失败。
 * 2. **参数搜索**：调用 P3 walk-forward 优化器。
 * 3. **样本外验证**：汇总验证段指标与稳定性得分（结果已在 walk-forward 内完成）。
 * 4. **报告生成**：输出 HTML/JSON 报告，写入结果库。
 *
 * 结果以 `MiningRun` + `MiningResult` 落库，`runId` 与审计日志、模拟交易验证记录
 * 使用同一标识体系（P5 依赖）。
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { formatDateTime } from '../format.js';
import type { HistoricalMarketData } from '../historical-market.js';
import {
  DEFAULT_WALKFORWARD_GRID,
  runBacktestWalkForward,
  type WalkForwardBacktestParams,
} from '../optimize/walkforward-runner.js';
import type {
  WalkForwardGrid,
  WalkForwardOptions,
} from '../optimize/walkforward.js';
import { enabledStrategyIds } from '../strategies/registry.js';
import type { FrictionCalibration } from './friction.js';
import { assessDataQuality, DEFAULT_QUALITY_THRESHOLDS, type QualityThresholds } from './quality.js';
import { renderMiningReportHtml } from './report.js';
import { MiningStore } from './store.js';
import type { MiningReport, MiningResult, MiningRun } from './types.js';

const execFileAsync = promisify(execFile);

/** P5：校准样本量门槛（与 friction.calibrationFromFriction 的默认一致）。 */
const MIN_CALIBRATION_SAMPLES = 5;
/** 默认持仓天数（与 walkforward-runner 的兜底一致）。 */
const DEFAULT_MAX_HOLD_DAYS = 5;

export interface MiningPipelineOptions {
  /** 标的池（股票代码）。 */
  universe: string[];
  /** 启用子策略 id；默认取环境变量解析结果（P2）。 */
  strategies?: string[];
  /** 回测窗口天数。 */
  days?: number;
  /** 参数网格；默认使用 P3 的默认网格。 */
  grid?: WalkForwardGrid;
  /** 网格之外的固定参数。 */
  baseParams?: WalkForwardBacktestParams;
  /** walk-forward 选项（窗口、步长、随机源等）。 */
  walkforward?: WalkForwardOptions;
  /** 数据质量阈值。 */
  thresholds?: QualityThresholds;
  /** 数据准备回调：补齐行情并返回快照。 */
  prepareData: () => Promise<HistoricalMarketData>;
  /** 落库存储。 */
  store?: MiningStore;
  /** 代码版本（git commit）；不传则自动读取。 */
  codeVersion?: string;
  /** 指定 runId（复现时使用）。 */
  runId?: string;
  /** 进度回调。 */
  progress?: (value: number, message: string) => void;
}

export interface MiningPipelineOutcome {
  run: MiningRun;
  results: MiningResult[];
  report: MiningReport;
  store: MiningStore;
}

/** 读取当前代码版本（git commit hash）；失败时返回 'unknown'。 */
export async function resolveCodeVersion(cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 5_000,
    });
    const hash = stdout.trim();
    return hash || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 计算数据版本标识：最后交易日 + 内容校验摘要。
 *
 * 摘要覆盖交易日历与每只标的的 K 线数量/末根收盘价，
 * 因此行情被重新采集后摘要会变化，可用于判断「数据是否还是同一份」。
 */
export function computeDataVersion(history: HistoricalMarketData): string {
  const hash = createHash('sha256');
  hash.update(history.as_of_date);
  hash.update('|');
  hash.update(history.calendar.join(','));
  for (const stock of [...history.stocks].sort((left, right) => left.stock_code.localeCompare(right.stock_code))) {
    hash.update('|');
    hash.update(stock.stock_code);
    hash.update(':');
    hash.update(String(stock.bars.length));
    hash.update(':');
    hash.update(String(stock.bars.at(-1)?.[2] ?? ''));
  }
  const digest = hash.digest('hex').slice(0, 12);
  return `${history.as_of_date}-${digest}`;
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `mining-${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * 执行挖掘流水线。
 *
 * 数据质量不达标时抛出错误，但**失败记录已落库**（status='failed' + error），
 * 保证缺口与失败原因可追溯，而不是静默跳过。
 */
export async function runMiningPipeline(
  options: MiningPipelineOptions,
): Promise<MiningPipelineOutcome> {
  const store = options.store ?? new MiningStore();
  const runId = options.runId ?? newRunId();
  const createdAt = formatDateTime();
  const strategies = options.strategies ?? enabledStrategyIds();
  const universe = [...new Set(options.universe.map((code) => String(code).trim()).filter(Boolean))];
  const grid = options.grid ?? DEFAULT_WALKFORWARD_GRID;
  const thresholds = options.thresholds ?? DEFAULT_QUALITY_THRESHOLDS;

  // P5：读取实测摩擦校准，用实测滑点覆盖回测默认滑点，让样本外评估贴近真实成交。
  const calibration = await store.getLatestCalibration();
  const usableCalibration = calibration && calibration.sampleSize >= MIN_CALIBRATION_SAMPLES
    ? calibration
    : null;
  const baseParams: WalkForwardBacktestParams = {
    maxHoldDays: DEFAULT_MAX_HOLD_DAYS,
    ...(options.baseParams ?? {}),
    ...(usableCalibration ? { slippageRate: usableCalibration.slippageRate } : {}),
  };

  const config: Record<string, unknown> = {
    days: options.days ?? 250,
    grid,
    baseParams,
    walkforward: options.walkforward ?? {},
    thresholds,
    ...(usableCalibration ? { calibration: usableCalibration } : {}),
  };

  const run: MiningRun = {
    runId,
    createdAt,
    codeVersion: options.codeVersion ?? await resolveCodeVersion(),
    dataVersion: 'unknown',
    universe,
    strategies,
    config,
    status: 'failed',
  };

  try {
    // ---- 环节 1：数据检查与补齐 ----
    options.progress?.(5, '检查并补齐历史行情数据');
    const history = await options.prepareData();
    run.dataVersion = computeDataVersion(history);
    const calendar = history.calendar.filter((date) => date <= history.as_of_date).sort();
    if (!calendar.length) throw new Error('交易日历为空，无法开始挖掘');
    const quality = assessDataQuality(
      history,
      universe,
      { start: calendar[0], end: calendar.at(-1)! },
      thresholds,
    );
    run.quality = quality;
    if (!quality.ok) {
      throw new Error(`数据质量检查未通过：${quality.reasons.join('；')}`);
    }
    options.progress?.(20, `数据质量检查通过（行情覆盖 ${(quality.priceCoverageRatio * 100).toFixed(1)}%）`);

    // ---- 环节 2：参数搜索（P3 walk-forward）----
    options.progress?.(30, '执行 walk-forward 参数搜索');
    const walkforward = await runBacktestWalkForward(history, {
      ...(options.walkforward ?? {}),
      days: options.days,
      grid,
      baseParams,
    });

    // ---- 环节 3：样本外验证汇总 ----
    options.progress?.(85, '汇总样本外指标与稳定性得分');
    // 样本外交易日数：各窗口验证段覆盖的交易日并集（相邻窗口可能重叠）。
    const outOfSampleDates = new Set<string>();
    for (const window of walkforward.windows) {
      for (const date of calendar) {
        if (date >= window.testRange.start && date <= window.testRange.end) outOfSampleDates.add(date);
      }
    }
    const outOfSampleDays = outOfSampleDates.size;
    const outOfSampleRange = walkforward.windows.length
      ? {
        start: walkforward.windows[0].testRange.start,
        end: walkforward.windows[walkforward.windows.length - 1].testRange.end,
      }
      : undefined;
    const results: MiningResult[] = walkforward.candidates.map((candidate, index) => ({
      runId,
      params: candidate.params,
      inSample: candidate.inSample,
      outOfSample: candidate.outOfSample,
      stabilityScore: candidate.stabilityScore,
      tradeCount: candidate.outOfSample.tradeCount,
      rank: index + 1,
      unstable: candidate.unstable,
      outOfSampleDays,
      outOfSampleRange,
    }));

    // ---- 环节 4：报告生成 ----
    options.progress?.(92, '生成挖掘报告');
    const report: MiningReport = {
      runId,
      createdAt,
      codeVersion: run.codeVersion,
      dataVersion: run.dataVersion,
      universe,
      strategies,
      quality,
      warnings: walkforward.warnings,
      aggregate: walkforward.aggregate,
      results,
      ...(usableCalibration ? { calibration: usableCalibration } : {}),
    };
    run.status = 'success';

    await store.saveRun(run);
    await store.saveResults(runId, results);
    await store.saveReport(report, renderMiningReportHtml(report));
    options.progress?.(100, '挖掘完成');

    return { run, results, report, store };
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    await store.saveRun(run);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI：tsx server/pipeline/mine.ts [days]
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 250);
  const { DataStore } = await import('../data-store.js');
  const { MarketService } = await import('../app/market-service.js');
  const { AuditLogger } = await import('../audit-log.js');
  const store = new DataStore();
  const audit = new AuditLogger(path.join(store.runtime, 'logs'));
  const marketService = new MarketService(store, audit);
  const universeSource = await store.getRankingUniverse();
  if (!universeSource.rankings.length) throw new Error('当前股票池为空，无法开始挖掘');

  const outcome = await runMiningPipeline({
    universe: universeSource.rankings.map((row) => row.stock_code),
    days,
    prepareData: async () => {
      const prepared = await marketService.ensureHistoricalCoverage({
        rankings: universeSource.rankings,
        days,
        asOfDate: universeSource.date,
        traceId: randomUUID(),
      });
      return prepared.history;
    },
    progress: (value, message) => console.log(`[mine] ${value}% ${message}`),
  });
  const best = outcome.results[0];
  console.log(JSON.stringify({
    run_id: outcome.run.runId,
    code_version: outcome.run.codeVersion,
    data_version: outcome.run.dataVersion,
    candidates: outcome.results.length,
    best_params: best?.params ?? {},
    best_out_of_sample: best?.outOfSample ?? null,
    report: path.join(outcome.store.root, 'reports', `${outcome.run.runId}.html`),
  }, null, 2));
}

const invokedDirectly = process.argv[1] && /mine(\.[cm]?[jt]s)?$/i.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
