/**
 * 下发实例的运行时（P5）。
 *
 * 一个「挖掘候选参数实例」是**独立**的模拟交易实例：
 * - 状态文件独立：`server/data/mining/instances/<instanceId>/state.json`，
 *   与生产 `paper_trading` 状态互不干扰；
 * - 审计独立：component 统一改写为 `mining_instance:<instanceId>`，日志可按实例检索；
 * - 队列独立：实例私有串行队列（broker 自身还有一层通道串行）；
 * - 通道受限：只接受 THS 模拟实现，杜绝真实资金通道接入这条链路。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PaperTradingRuntimeState } from '../../src/types.js';
import { NOOP_AUDIT_LOGGER, type AuditDetails, type AuditLoggerLike } from '../audit-log.js';
import { PaperTradingService } from '../paper-trading.js';
import {
  defaultState,
  type PaperMarketContext,
  type PaperTradingServiceOptions,
  type PaperTradingStateStore,
  type ThsReadinessProvider,
} from '../paper-trading/helpers.js';
import { ThsSimulatedBroker } from '../ths-simulated-broker.js';
import { ThsWebSimulatedBroker } from '../ths-web-broker.js';
import type { SimulatedBroker } from '../ths-simulated-broker.js';
import type { TradingWindow } from '../../src/types.js';
import { instanceDir, instanceStatePath, InstanceSerialQueue, type MiningInstanceConfig } from './deploy.js';
import { DEFAULT_MINING_DIR } from './store.js';

export interface MiningInstanceRuntimeDeps {
  broker: SimulatedBroker;
  marketDataProvider?: (window: TradingWindow, traceId: string) => Promise<PaperMarketContext>;
  calendarRefresher?: () => Promise<string[]>;
  thsReadiness?: ThsReadinessProvider;
  audit?: AuditLoggerLike;
  now?: () => Date;
}

export interface MiningInstanceRuntime {
  config: MiningInstanceConfig;
  /** 实例私有串行队列。 */
  queue: InstanceSerialQueue;
  service: PaperTradingService;
  /** 读取该实例自己的运行状态（含指令，供验证报告使用）。 */
  getState(): Promise<PaperTradingRuntimeState>;
  /** 仅模拟通道断言：broker 必须是 THS 模拟实现。 */
  assertSimulatedOnly(): void;
}

/** 文件式状态存储：每个实例一份 state.json，与生产状态分离。 */
class InstanceFileStateStore implements PaperTradingStateStore {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(filePath: string, now: () => Date) {
    this.filePath = filePath;
    this.now = now;
  }

  async load(): Promise<PaperTradingRuntimeState | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as PaperTradingRuntimeState;
    } catch {
      return null;
    }
  }

  async save(state: PaperTradingRuntimeState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    } finally {
      try {
        await unlink(tempPath);
      } catch {
        // 临时文件可能已被 rename 掉。
      }
    }
  }

  /** 新实例的初始状态。 */
  initialState(): PaperTradingRuntimeState {
    return defaultState(this.now().toISOString());
  }
}

/**
 * 把审计 component 改写为实例命名空间，使实例日志与生产日志可区分。
 */
function scopedAuditLogger(base: AuditLoggerLike, instanceId: string): AuditLoggerLike {
  const scope = `mining_instance:${instanceId}`;
  const rewrite = (component: string) => `${scope}:${component}`;
  const wrap = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (component: string, event: string, details?: AuditDetails) =>
      base[level](rewrite(component), event, details);
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    query: (query) => base.query(query),
    files: () => base.files(),
  };
}

/**
 * 只接受 THS 模拟通道实现。
 *
 * 真实资金通道一旦混入这条链路，P5 的「无真实交易风险敞口」承诺就失效了，
 * 因此在运行时创建前就硬拒绝。
 */
export function assertSimulatedChannel(broker: SimulatedBroker): void {
  if (broker instanceof ThsSimulatedBroker || broker instanceof ThsWebSimulatedBroker) return;
  throw new Error('下发实例只允许 THS 模拟交易通道，拒绝接入非模拟 broker');
}

/**
 * 读取下发实例自己的运行状态（不启动运行时也能读）。
 *
 * 实例尚未产生状态文件时返回 null。
 */
export async function readInstanceState(
  root: string,
  instanceId: string,
): Promise<PaperTradingRuntimeState | null> {
  const store = new InstanceFileStateStore(instanceStatePath(root, instanceId), () => new Date());
  return store.load();
}

/**
 * 创建下发实例运行时。
 */
export async function createMiningInstanceRuntime(
  config: MiningInstanceConfig,
  deps: MiningInstanceRuntimeDeps,
  options?: { root?: string },
): Promise<MiningInstanceRuntime> {
  if (config.channel !== 'simulated') {
    throw new Error('下发实例只允许模拟通道');
  }
  assertSimulatedChannel(deps.broker);

  const root = options?.root ?? DEFAULT_MINING_DIR;
  const now = deps.now ?? (() => new Date());
  await mkdir(instanceDir(root, config.instanceId), { recursive: true });

  const stateStore = new InstanceFileStateStore(instanceStatePath(root, config.instanceId), now);
  const audit = scopedAuditLogger(deps.audit ?? NOOP_AUDIT_LOGGER, config.instanceId);
  const queue = new InstanceSerialQueue();

  const serviceOptions: PaperTradingServiceOptions = {
    stateStore,
    marketDataProvider: deps.marketDataProvider,
    calendarRefresher: deps.calendarRefresher,
    thsReadiness: deps.thsReadiness,
    audit,
    now,
    entryStrategyIds: [...config.strategyIds],
  };
  const service = new PaperTradingService(deps.broker, serviceOptions);
  await service.applyMiningInstance(config);

  return {
    config,
    queue,
    service,
    getState: () => service.getRuntimeState(),
    assertSimulatedOnly: () => assertSimulatedChannel(deps.broker),
  };
}
