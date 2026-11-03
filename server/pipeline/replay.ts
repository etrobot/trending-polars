/**
 * 挖掘流水线复现（P4）。
 *
 * 凭 `runId` 还原原始运行的三要素（代码版本、数据版本、完整配置），
 * 用同样的配置重跑一遍，并逐条对比结果差异。
 *
 * 用法（项目根目录）：
 *   tsx server/pipeline/replay.ts <runId>
 */

import { formatDateTime } from '../format.js';
import type { HistoricalMarketData } from '../historical-market.js';
import type { WalkForwardBacktestParams } from '../optimize/walkforward-runner.js';
import type { WalkForwardGrid, WalkForwardOptions } from '../optimize/walkforward.js';
import { runMiningPipeline, type MiningPipelineOptions } from './mine.js';
import { MiningStore } from './store.js';
import type { MiningResult, MiningRun } from './types.js';

export interface ReplayDiffEntry {
  /** 参数组合（序列化后作为键）。 */
  params: Record<string, number>;
  /** 原始排名。 */
  originalRank: number;
  /** 复现排名。 */
  replayRank: number;
  /** 样本外夏普差（复现 - 原始）。 */
  sharpeDelta: number;
  /** 样本外年化收益差。 */
  annualReturnDelta: number;
  /** 稳定性得分差。 */
  stabilityScoreDelta: number;
  /** 是否为指标不一致的组合。 */
  changed: boolean;
}

export interface ReplayOutcome {
  originalRun: MiningRun;
  replayRun: MiningRun;
  /** 原始与复现的样本外指标是否完全一致。 */
  identical: boolean;
  /** 代码版本是否发生变化。 */
  codeVersionChanged: boolean;
  /** 数据版本是否发生变化。 */
  dataVersionChanged: boolean;
  diffs: ReplayDiffEntry[];
  /** 不一致的组合数量。 */
  changedCount: number;
  message: string;
}

/** 指标比较容差（浮点舍入误差）。 */
const EPSILON = 1e-6;

function paramsKey(params: Record<string, number>): string {
  return Object.keys(params).sort().map((key) => `${key}:${params[key]}`).join('|');
}

function compareResults(
  original: MiningResult[],
  replay: MiningResult[],
): ReplayDiffEntry[] {
  const originalByKey = new Map(original.map((item) => [paramsKey(item.params), item]));
  const replayByKey = new Map(replay.map((item) => [paramsKey(item.params), item]));
  const keys = [...new Set([...originalByKey.keys(), ...replayByKey.keys()])].sort();
  const diffs: ReplayDiffEntry[] = [];
  for (const key of keys) {
    const before = originalByKey.get(key);
    const after = replayByKey.get(key);
    const sharpeDelta = after && before ? after.outOfSample.sharpe - before.outOfSample.sharpe : 0;
    const annualReturnDelta = after && before
      ? after.outOfSample.annualReturn - before.outOfSample.annualReturn
      : 0;
    const stabilityScoreDelta = after && before
      ? after.stabilityScore - before.stabilityScore
      : 0;
    const changed = !before || !after
      || Math.abs(sharpeDelta) > EPSILON
      || Math.abs(annualReturnDelta) > EPSILON
      || Math.abs(stabilityScoreDelta) > EPSILON;
    diffs.push({
      params: after?.params ?? before?.params ?? {},
      originalRank: before?.rank ?? -1,
      replayRank: after?.rank ?? -1,
      sharpeDelta,
      annualReturnDelta,
      stabilityScoreDelta,
      changed,
    });
  }
  return diffs;
}

/**
 * 按原配置重跑一次挖掘并对比差异。
 *
 * 复现使用新的 runId（`<原 runId>-replay-<时间戳>`），不覆盖原始记录；
 * 重跑结果与原始结果的样本外指标应完全一致（同数据 + 同配置 + 同随机源）。
 */
export async function replayMiningRun(
  runId: string,
  options: {
    prepareData: () => Promise<HistoricalMarketData>;
    store?: MiningStore;
    /** 覆盖复现使用的 runId（测试用）。 */
    replayRunId?: string;
  },
): Promise<ReplayOutcome> {
  const store = options.store ?? new MiningStore();
  const originalRun = await store.getRun(runId);
  if (!originalRun) throw new Error(`挖掘记录不存在：${runId}`);
  const originalResults = await store.getResults(runId);

  const config = originalRun.config ?? {};
  const grid = (config.grid ?? {}) as WalkForwardGrid;
  const baseParams = (config.baseParams ?? {}) as WalkForwardBacktestParams;
  const walkforward = (config.walkforward ?? {}) as WalkForwardOptions;

  const replayRunId = options.replayRunId
    ?? `${runId}-replay-${formatDateTime().replace(/\D/g, '').slice(0, 14)}`;

  const pipelineOptions: MiningPipelineOptions = {
    universe: originalRun.universe,
    strategies: originalRun.strategies,
    days: Number(config.days ?? 250),
    grid,
    baseParams,
    walkforward,
    thresholds: config.thresholds as MiningPipelineOptions['thresholds'],
    prepareData: options.prepareData,
    store,
    codeVersion: originalRun.codeVersion,
    runId: replayRunId,
  };

  const outcome = await runMiningPipeline(pipelineOptions);
  const diffs = compareResults(originalResults, outcome.results);
  const changedCount = diffs.filter((diff) => diff.changed).length;
  const identical = changedCount === 0;

  return {
    originalRun,
    replayRun: outcome.run,
    identical,
    codeVersionChanged: outcome.run.codeVersion !== originalRun.codeVersion,
    dataVersionChanged: outcome.run.dataVersion !== originalRun.dataVersion,
    diffs,
    changedCount,
    message: identical
      ? `复现一致：${outcome.results.length} 组参数的样本外指标与原记录完全相同`
      : `复现存在差异：${changedCount}/${diffs.length} 组参数指标不一致`,
  };
}

// ---------------------------------------------------------------------------
// CLI：tsx server/pipeline/replay.ts <runId>
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runId = process.argv[2]?.trim();
  if (!runId) {
    console.error('用法：tsx server/pipeline/replay.ts <runId>');
    process.exitCode = 1;
    return;
  }
  const store = new MiningStore();
  const { DataStore } = await import('../data-store.js');
  const dataStore = new DataStore();
  const outcome = await replayMiningRun(runId, {
    store,
    prepareData: async () => {
      const history = await dataStore.getHistoricalMarket();
      if (!history) throw new Error('本地没有历史行情快照，无法复现');
      return history;
    },
  });
  console.log(JSON.stringify({
    run_id: runId,
    replay_run_id: outcome.replayRun.runId,
    identical: outcome.identical,
    changed_count: outcome.changedCount,
    code_version_changed: outcome.codeVersionChanged,
    data_version_changed: outcome.dataVersionChanged,
    message: outcome.message,
  }, null, 2));
}

const invokedDirectly = process.argv[1]
  && /replay(\.[cm]?[jt]s)?$/i.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
