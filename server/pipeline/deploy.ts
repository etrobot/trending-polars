/**
 * 候选参数下发（P5）。
 *
 * 把 P4 挖掘出来的候选参数（`runId + 排名序号`）一次操作落成一个**独立的**
 * 模拟交易实例配置。关键约束：
 *
 * - **显式确认**：请求必须带 `operator`（操作人）与 `confirmation`（必须等于 runId），
 *   避免误点就把某个批次推上模拟盘。
 * - **只走模拟通道**：实例配置写死 `channel: 'simulated'`，不接受任何真实资金参数。
 * - **与生产实例隔离**：实例配置落在 `server/data/mining/instances/`，
 *   运行状态、审计 component、串行队列都与生产模拟交易互不干扰。
 */

import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MINING_DIR, MiningStore } from './store.js';
import type { MiningResult, MiningRun } from './types.js';

/** 默认资金上限（元）。 */
export const DEFAULT_CAPITAL_LIMIT = 100_000;

export interface MiningDeployRequest {
  runId: string;
  /** 结果排名序号（1 起，对应 MiningResult.rank）。 */
  rank: number;
  /** 操作人（必填，落库与审计）。 */
  operator: string;
  /** 显式确认串，必须等于 runId。 */
  confirmation: string;
  /** 可选覆盖标的池；缺省用 run.universe。 */
  universe?: string[];
  /** 可选资金上限（元）；缺省 DEFAULT_CAPITAL_LIMIT。 */
  capitalLimit?: number;
  /** 可选启用子策略；缺省用 run.strategies。 */
  strategyIds?: string[];
}

export interface MiningInstanceConfig {
  instanceId: string;
  createdAt: string;
  operator: string;
  sourceRunId: string;
  sourceRank: number;
  params: Record<string, number>;
  universe: string[];
  capitalLimit: number;
  strategyIds: string[];
  status: 'created' | 'active' | 'stopped';
  /** 通道标识：只有模拟，不存在真实资金分支。 */
  channel: 'simulated';
}

function dedupe(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

/**
 * 由「批次 + 排名 + 确认」生成实例配置。
 *
 * 所有拒绝理由都用可读中文抛出，调用方（HTTP / CLI）直接透传给操作人。
 */
export function buildInstanceConfig(
  request: MiningDeployRequest,
  run: MiningRun,
  result: MiningResult,
  options?: { now?: () => Date },
): MiningInstanceConfig {
  const operator = String(request.operator ?? '').trim();
  if (!operator) {
    throw new Error('下发必须记录操作人');
  }
  if (String(request.confirmation ?? '').trim() !== run.runId) {
    throw new Error('下发需显式确认：请把 runId 原样填入 confirmation');
  }
  if (run.status !== 'success') {
    throw new Error('只能下发成功的挖掘批次');
  }
  if (result.rank !== request.rank) {
    throw new Error('排名序号与结果不匹配');
  }
  const capitalLimit = request.capitalLimit ?? DEFAULT_CAPITAL_LIMIT;
  if (!Number.isFinite(capitalLimit) || capitalLimit <= 0) {
    throw new Error('资金上限必须为正数');
  }
  const universe = dedupe(request.universe ?? run.universe);
  if (!universe.length) {
    throw new Error('标的池为空，拒绝下发');
  }
  const strategyIds = dedupe(request.strategyIds ?? run.strategies);
  if (!strategyIds.length) {
    throw new Error('启用子策略为空，拒绝下发');
  }

  const now = options?.now?.() ?? new Date();
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);

  return {
    instanceId: `mining-inst-${stamp}-${randomUUID().slice(0, 8)}`,
    createdAt: now.toISOString(),
    operator,
    sourceRunId: run.runId,
    sourceRank: result.rank,
    params: { ...result.params },
    universe,
    capitalLimit,
    strategyIds,
    status: 'created',
    channel: 'simulated',
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    await rename(tempPath, filePath);
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // 临时文件可能已被 rename 掉。
    }
  }
}

/**
 * 已下发实例的落库。
 *
 * 目录：`server/data/mining/instances/<instanceId>.json`，与生产模拟交易状态完全分离。
 */
export class MiningInstanceStore {
  readonly root: string;

  constructor(root = DEFAULT_MINING_DIR) {
    this.root = root;
  }

  private instancePath(instanceId: string): string {
    return path.join(this.root, 'instances', `${instanceId}.json`);
  }

  async save(config: MiningInstanceConfig): Promise<void> {
    await writeJson(this.instancePath(config.instanceId), config);
  }

  async get(instanceId: string): Promise<MiningInstanceConfig | null> {
    const filePath = this.instancePath(instanceId);
    if (!(await exists(filePath))) return null;
    return readJson<MiningInstanceConfig>(filePath);
  }

  async list(): Promise<MiningInstanceConfig[]> {
    const dir = path.join(this.root, 'instances');
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const configs: MiningInstanceConfig[] = [];
    for (const name of names) {
      try {
        configs.push(await readJson<MiningInstanceConfig>(path.join(dir, name)));
      } catch {
        // 单个损坏文件不应让整个列表不可用。
      }
    }
    return configs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async update(instanceId: string, patch: Partial<MiningInstanceConfig>): Promise<MiningInstanceConfig> {
    const current = await this.get(instanceId);
    if (!current) {
      throw new Error(`实例不存在：${instanceId}`);
    }
    const next: MiningInstanceConfig = { ...current, ...patch, instanceId: current.instanceId };
    await this.save(next);
    return next;
  }
}

/**
 * 实例私有串行队列。
 *
 * 与生产实例不共享队列；THS 通道本身还有 broker 级串行，两层叠加保证不会交错下单。
 */
export class InstanceSerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** 实例运行状态文件路径（与生产 paper_trading 状态分离）。 */
export function instanceStatePath(root: string, instanceId: string): string {
  return path.join(root, 'instances', instanceId, 'state.json');
}

/** 实例目录。 */
export function instanceDir(root: string, instanceId: string): string {
  return path.join(root, 'instances', instanceId);
}

// ---------------------------------------------------------------------------
// CLI：tsx server/pipeline/deploy.ts <runId> <rank> <operator>
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [runId, rankRaw, operator] = process.argv.slice(2);
  if (!runId || !rankRaw || !operator) {
    console.error('用法：tsx server/pipeline/deploy.ts <runId> <rank> <operator>');
    process.exitCode = 1;
    return;
  }
  const rank = Number(rankRaw);
  if (!Number.isFinite(rank)) {
    console.error('排名必须是数字');
    process.exitCode = 1;
    return;
  }

  const store = new MiningStore();
  const run = await store.getRun(runId);
  if (!run) {
    console.error(`找不到挖掘批次：${runId}`);
    process.exitCode = 1;
    return;
  }
  const results = await store.getResults(runId);
  const result = results.find((item) => item.rank === rank);
  if (!result) {
    console.error(`批次 ${runId} 中没有排名 ${rank} 的候选`);
    process.exitCode = 1;
    return;
  }

  // CLI 是显式人工操作，确认串固定为 runId。
  const config = buildInstanceConfig(
    { runId, rank, operator, confirmation: runId },
    run,
    result,
  );
  const instanceStore = new MiningInstanceStore();
  await instanceStore.save(config);

  console.log('[mining-deploy] 已下发模拟交易实例');
  console.log(JSON.stringify(config, null, 2));
}

// 仅在直接以 tsx 执行本文件时跑 CLI（被 import 时不触发）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error('[mining-deploy] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
