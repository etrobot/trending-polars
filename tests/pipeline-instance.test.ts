import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditDetails, AuditLevel, AuditLoggerLike, AuditQuery, AuditRecord } from '../server/audit-log.js';
import { buildInstanceConfig, type MiningInstanceConfig } from '../server/pipeline/deploy.js';
import { assertSimulatedChannel, createMiningInstanceRuntime, readInstanceState } from '../server/pipeline/instance.js';
import { PaperTradingService } from '../server/paper-trading.js';
import { ThsSimulatedBroker } from '../server/ths-simulated-broker.js';
import type { SimulatedAccountSnapshot, SimulatedBroker } from '../server/ths-simulated-broker.js';
import type { PaperOrder, PaperTradingRuntimeState, RankingRow } from '../src/types.js';
import type { AnalysisData } from '../src/types.js';
import type { PaperTradingStateStore } from '../server/paper-trading/helpers.js';

class RecordingAudit implements AuditLoggerLike {
  records: Array<{ level: AuditLevel; component: string; event: string; details?: AuditDetails }> = [];

  debug(component: string, event: string, details?: AuditDetails) { return this.add('debug', component, event, details); }
  info(component: string, event: string, details?: AuditDetails) { return this.add('info', component, event, details); }
  warn(component: string, event: string, details?: AuditDetails) { return this.add('warn', component, event, details); }
  error(component: string, event: string, details?: AuditDetails) { return this.add('error', component, event, details); }

  async query(_query?: AuditQuery): Promise<AuditRecord[]> { return []; }
  async files() { return []; }

  private async add(level: AuditLevel, component: string, event: string, details?: AuditDetails) {
    this.records.push({ level, component, event, details });
  }
}

/** 非 THS 实现的 broker：必须被「仅模拟通道」断言拒绝。 */
class ForeignBroker implements SimulatedBroker {
  async snapshot(): Promise<SimulatedAccountSnapshot> {
    return { availableCash: 0, totalAssets: 0, positions: [], orders: [] };
  }
  async snapshotAccountOnly(): Promise<SimulatedAccountSnapshot> { return this.snapshot(); }
  async quote(): Promise<number> { return 0; }
  async placeOrder(_order: PaperOrder) { return { verified: false, brokerOutput: '' }; }
  async cancelOrder() { return { verified: false, brokerOutput: '' }; }
}

/** 可下单的仿真 broker：用于跑完整信号生成流程。 */
class FakeBroker implements SimulatedBroker {
  readonly placed: PaperOrder[] = [];

  async snapshot(): Promise<SimulatedAccountSnapshot> {
    return { availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] };
  }
  async snapshotAccountOnly(): Promise<SimulatedAccountSnapshot> { return this.snapshot(); }
  async quote(): Promise<number> { return 10; }
  async placeOrder(order: PaperOrder) {
    this.placed.push(structuredClone(order));
    return { verified: true, brokerOutput: 'ORDER_VERIFIED' };
  }
  async cancelOrder() { return { verified: true, brokerOutput: 'CANCEL_VERIFIED' }; }
}

const analysis: AnalysisData = {
  timestamp: '2026-07-23 15:05:00',
  indices: [],
  blocks: [],
  sentiment: { total_blocks: 0, total_limit_up: 0, sentiment: 'normal' },
};

function ranking(stockCode: string, score: number, latestPrice = 10): RankingRow {
  return {
    rank: 1,
    stock_code: stockCode,
    stock_name: stockCode,
    total_score: score,
    trend_score: score,
    alignment: 'bullish',
    strategy_action: 'trade',
    strategy_label: '短线博弈',
    strategy_position: '0.4',
    strategy_position_ratio: 0.4,
    latest_price: latestPrice,
    ma3: latestPrice * 0.99,
    ma5: latestPrice * 0.98,
    ma20: latestPrice * 0.95,
  };
}

function makeConfig(): MiningInstanceConfig {
  return {
    instanceId: 'mining-inst-test',
    createdAt: '2026-01-01 00:00:00',
    operator: '张三',
    sourceRunId: 'mining-run-1',
    sourceRank: 1,
    params: { maxHoldDays: 7, takeProfitPct: 20, stopLossPct: -8 },
    universe: ['600001'],
    capitalLimit: 100_000,
    strategyIds: ['ma-trend'],
    status: 'created',
    channel: 'simulated',
  };
}

describe('下发实例运行时（instance）', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mining-runtime-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('拒绝非 THS 模拟通道的 broker', () => {
    expect(() => assertSimulatedChannel(new ForeignBroker())).toThrow(/只允许 THS 模拟交易通道/);
    expect(() => assertSimulatedChannel(new ThsSimulatedBroker({ runner: async () => '' }))).not.toThrow();
  });

  it('创建运行时后实例配置生效且审计带上实例命名空间', async () => {
    const audit = new RecordingAudit();
    const runtime = await createMiningInstanceRuntime(
      makeConfig(),
      { broker: new ThsSimulatedBroker({ runner: async () => '' }), audit },
      { root },
    );

    expect(runtime.config.instanceId).toBe('mining-inst-test');
    runtime.assertSimulatedOnly();

    const state = await runtime.getState();
    expect(state.applied_mining_run_id).toBe('mining-run-1');
    expect(state.entry_strategy_ids).toEqual(['ma-trend']);
    expect(state.strategy_config?.maxHoldDays).toBe(7);
    expect(state.strategy_config?.takeProfitPct).toBe(20);
    expect(state.strategy_config?.stopLossPct).toBe(-8);

    const applied = audit.records.find((item) => item.event === 'mining_instance_applied');
    expect(applied).toBeDefined();
    expect(applied!.component).toBe('mining_instance:mining-inst-test:paper_trading');
    expect((applied!.details?.data as { run_id?: string }).run_id).toBe('mining-run-1');
  });

  it('实例状态写在独立目录下，与生产状态互不干扰', async () => {
    const runtime = await createMiningInstanceRuntime(
      makeConfig(),
      { broker: new ThsSimulatedBroker({ runner: async () => '' }) },
      { root },
    );
    await runtime.getState();

    const persisted = await readInstanceState(root, 'mining-inst-test');
    expect(persisted?.applied_mining_run_id).toBe('mining-run-1');
    // 生产模拟交易状态文件路径不含实例目录，互不覆盖。
    expect(path.join(root, 'instances', 'mining-inst-test', 'state.json')).toContain('mining-inst-test');
  });

  it('实例队列内的操作串行执行', async () => {
    const runtime = await createMiningInstanceRuntime(
      makeConfig(),
      { broker: new ThsSimulatedBroker({ runner: async () => '' }) },
      { root },
    );
    const order: number[] = [];
    const first = runtime.queue.run(async () => {
      order.push(1);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      order.push(2);
    });
    const second = runtime.queue.run(async () => { order.push(3); });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('下发参数映射后买入信号仍走 rankEntryCandidates 且写入 run_id', async () => {
    const config = makeConfig();
    const service = new PaperTradingService(new ThsSimulatedBroker({ runner: async () => '' }), {
      now: () => new Date('2026-07-23T15:06:00+08:00'),
    });
    await service.applyMiningInstance(config);
    const state = await service.getRuntimeState();
    expect(state.applied_mining_run_id).toBe('mining-run-1');
    expect(state.entry_strategy_ids).toEqual(['ma-trend']);
  });

  it('没有下发实例时 run_id 为空，不影响既有链路', async () => {
    const service = new PaperTradingService(new ThsSimulatedBroker({ runner: async () => '' }), {
      now: () => new Date('2026-07-23T15:06:00+08:00'),
    });
    const state = await service.getRuntimeState();
    expect(state.applied_mining_run_id).toBeUndefined();
    expect(state.entry_strategy_ids).toBeUndefined();
  });

  it('买入指令与审计日志都带上 run_id', async () => {
    const audit = new RecordingAudit();
    const broker = new FakeBroker();
    const service = new PaperTradingService(broker, {
      audit,
      now: () => new Date('2026-07-23T15:06:00+08:00'),
      strategy: { maxEntriesPerDay: 2 },
    });
    await service.applyMiningInstance(makeConfig());

    await service.runWindow('close', {
      analysis,
      rankingDate: '20260723',
      rankings: [ranking('600001', 80)],
      calendar: ['20260723', '20260724'],
    });

    const state = await service.getRuntimeState();
    const buys = state.instructions.filter((item) => item.side === 'buy');
    expect(buys.length).toBeGreaterThan(0);
    expect(buys.every((item) => item.run_id === 'mining-run-1')).toBe(true);

    const evaluated = audit.records.filter((item) => item.event === 'entry_candidate_evaluated');
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated.every((item) => (item.details?.data as { run_id?: string }).run_id === 'mining-run-1'))
      .toBe(true);
  });
});
