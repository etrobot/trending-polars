import { describe, expect, it } from 'vitest';
import type { AuditDetails, AuditLevel, AuditLogFile, AuditLoggerLike, AuditQuery, AuditRecord } from '../server/audit-log.js';
import {
  PaperTradingService,
  type PaperMarketContext,
  type PaperTradingStateStore,
} from '../server/paper-trading.js';
import {
  defaultState,
  immediateAutoWindowRejection,
  isAccountSyncOnlyPeriod,
  isTradingDay,
  nextTradingDateAfter,
  resolveAutoTradingWindow,
  shanghaiClock,
  thsReadyTimeoutMs,
  thsWarmupSlot,
  windowRetryDelayMs,
} from '../server/paper-trading/helpers.js';
import type { SimulatedAccountSnapshot, SimulatedBroker } from '../server/ths-simulated-broker.js';
import type { AnalysisData, PaperOrder, PaperTradingRuntimeState, RankingRow } from '../src/types.js';

class TestStateStore implements PaperTradingStateStore {
  state: PaperTradingRuntimeState | null = null;
  saves = 0;

  async load() {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: PaperTradingRuntimeState) {
    this.saves += 1;
    this.state = structuredClone(state);
  }
}

/** 同花顺完全不可用：任何一次调用都抛错。 */
class OfflineBroker implements SimulatedBroker {
  async snapshot(): Promise<never> { throw new Error('同花顺尚未运行 (-2700)'); }
  async snapshotAccountOnly(): Promise<never> { throw new Error('同花顺尚未运行 (-2700)'); }
  async quote(): Promise<never> { throw new Error('同花顺尚未运行 (-2700)'); }
  async placeOrder(): Promise<never> { throw new Error('同花顺尚未运行 (-2700)'); }
  async cancelOrder(): Promise<never> { throw new Error('同花顺尚未运行 (-2700)'); }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

class RecordingAudit implements AuditLoggerLike {
  records: Array<{ level: AuditLevel; component: string; event: string; details?: AuditDetails }> = [];

  debug(component: string, event: string, details?: AuditDetails) { return this.add('debug', component, event, details); }
  info(component: string, event: string, details?: AuditDetails) { return this.add('info', component, event, details); }
  warn(component: string, event: string, details?: AuditDetails) { return this.add('warn', component, event, details); }
  error(component: string, event: string, details?: AuditDetails) { return this.add('error', component, event, details); }

  async query(_query?: AuditQuery): Promise<AuditRecord[]> { return []; }
  async files(): Promise<AuditLogFile[]> { return []; }

  private async add(level: AuditLevel, component: string, event: string, details?: AuditDetails) {
    this.records.push({ level, component, event, details });
  }
}

class OrderStartFailingAudit extends RecordingAudit {
  override info(component: string, event: string, details?: AuditDetails): Promise<void> {
    if (component === 'order' && event === 'submission_started') {
      return Promise.reject(new Error('审计日志目录不可写'));
    }
    return super.info(component, event, details);
  }
}

class FlowBroker implements SimulatedBroker {
  readonly placed: PaperOrder[] = [];

  constructor(public account: SimulatedAccountSnapshot, private readonly quotes: Record<string, number> = {}) {}

  async snapshot(): Promise<SimulatedAccountSnapshot> {
    return structuredClone(this.account);
  }

  async snapshotAccountOnly(): Promise<SimulatedAccountSnapshot> {
    const snapshot = structuredClone(this.account);
    snapshot.orders = [];
    return snapshot;
  }

  async quote(stockCode: string): Promise<number> {
    return this.quotes[stockCode] ?? 10;
  }

  async placeOrder(order: PaperOrder) {
    this.placed.push(structuredClone(order));
    if (order.side === 'buy') {
      this.account.availableCash -= order.amount;
      this.account.positions.push({
        stock_code: order.stock_code,
        stock_name: order.stock_name,
        shares: order.quantity,
        available_shares: 0,
        cost_price: order.price,
        current_price: order.price,
        market_value: order.amount,
        pnl_amount: 0,
        pnl_pct: 0,
      });
    } else {
      const position = this.account.positions.find((item) => item.stock_code === order.stock_code);
      if (position) this.account.availableCash += position.current_price * order.quantity;
      this.account.positions = this.account.positions.filter((item) => item.stock_code !== order.stock_code);
    }
    this.account.orders.unshift({ ...order, status: '全部成交', cancelable: false });
    return { verified: true, brokerOutput: `ORDER_VERIFIED|${order.stock_code}` };
  }

  async cancelOrder(_side: 'buy' | 'sell', stockCode: string) {
    return { verified: true, brokerOutput: `CANCEL_VERIFIED|${stockCode}` };
  }
}

class FailingBroker extends FlowBroker {
  attempts = 0;

  override async placeOrder(_order: PaperOrder): Promise<never> {
    this.attempts += 1;
    throw new Error('AppleScript 回查超时');
  }
}

const analysis: AnalysisData = {
  timestamp: '2026-07-23 15:05:00',
  indices: [],
  blocks: [],
  sentiment: { total_blocks: 0, total_limit_up: 0, sentiment: 'normal' },
};

function ranking(stockCode: string, stockName: string, score: number, latestPrice = 10, rank = 1): RankingRow {
  return {
    rank,
    stock_code: stockCode,
    stock_name: stockName,
    total_score: score,
    trend_score: score,
    alignment: 'bullish',
    strategy_action: 'trade',
    strategy_label: '短线博弈',
    strategy_position: '0.4',
    strategy_position_ratio: 0.4,
    latest_price: latestPrice,
  };
}

function context(
  date: string,
  rankings: RankingRow[],
  calendar: string[] = [],
  marketAnalysis: AnalysisData = analysis,
  marketAverageChange?: number,
  limitUpRecords: Array<{ date: string; stock_code: string }> = [],
): PaperMarketContext {
  return { analysis: marketAnalysis, rankingDate: date, rankings, calendar, marketAverageChange, limitUpRecords };
}

function analysisForTiming(sentiment: 'hot' | 'normal' | 'cold', stateId?: number): AnalysisData {
  return {
    ...analysis,
    sentiment: { total_blocks: 1, total_limit_up: sentiment === 'hot' ? 100 : 10, sentiment },
    indices: stateId == null ? [] : [{
      name: '沪深300',
      code: 'sh000300',
      state: { state_id: stateId, state_name: stateId >= 6 ? '风险' : '偏强' },
      price: 4_000,
      date: '2026-07-22',
      signal: stateId >= 6 ? 'empty' : 'buy',
    }],
  };
}

describe('Node T+1 paper-trading core', () => {
  it('does not infer limit-up from quote amplitude and skips only block_top-confirmed stocks', async () => {
    let now = new Date('2026-07-22T15:06:00+08:00');
    const highQuoteBroker = new FlowBroker({
      availableCash: 100_000,
      totalAssets: 100_000,
      positions: [],
      orders: [],
    }, { '000001': 11 });
    const service = new PaperTradingService(highQuoteBroker, { now: () => now });
    const signalContext = context('20260722', [ranking('000001', '振幅测试', 80, 10)], ['20260722', '20260723']);
    await service.runWindow('close', signalContext);
    now = new Date('2026-07-23T09:31:00+08:00');
    await service.runWindow('open', signalContext);
    expect(highQuoteBroker.placed).toEqual([
      expect.objectContaining({ side: 'buy', stock_code: '000001', price: 11 }),
    ]);

    now = new Date('2026-07-22T15:06:00+08:00');
    const confirmedBroker = new FlowBroker({
      availableCash: 100_000,
      totalAssets: 100_000,
      positions: [],
      orders: [],
    }, { '000001': 10 });
    const confirmedService = new PaperTradingService(confirmedBroker, { now: () => now });
    await confirmedService.runWindow('close', signalContext);
    now = new Date('2026-07-23T09:31:00+08:00');
    await confirmedService.runWindow('open', context(
      '20260722',
      [ranking('000001', '振幅测试', 80, 10)],
      ['20260722', '20260723'],
      analysis,
      undefined,
      [{ date: '20260723', stock_code: '000001' }],
    ));
    expect(confirmedBroker.placed).toEqual([]);
  });

  it('backfills the previous close plan from ranking order and respects the total position limit', async () => {
    const now = new Date('2026-07-23T11:00:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({
      availableCash: 80_000,
      totalAssets: 100_000,
      positions: [
        {
          stock_code: '600001',
          stock_name: '排行第一',
          shares: 1000,
          available_shares: 1000,
          cost_price: 10,
          current_price: 10,
          market_value: 10_000,
          pnl_amount: 0,
          pnl_pct: 0,
        },
        {
          stock_code: '300003',
          stock_name: '排行第三',
          shares: 1000,
          available_shares: 1000,
          cost_price: 10,
          current_price: 10,
          market_value: 10_000,
          pnl_amount: 0,
          pnl_pct: 0,
        },
      ],
      orders: [],
    });
    const service = new PaperTradingService(broker, {
      stateStore: store,
      now: () => now,
      strategy: { maxPositions: 3, maxEntriesPerDay: 2 },
    });
    const market = context('20260722', [
      ranking('600001', '排行第一', 90, 10, 1),
      ranking('000002', '排行第二', 85, 10, 2),
      ranking('300003', '排行第三', 80, 10, 3),
      ranking('600004', '排行第四', 75, 10, 4),
    ], ['20260722', '20260723']);

    const overview = await service.overview(market.analysis, market.rankingDate, market.rankings, market.calendar);
    expect(overview.plan.max_positions).toBe(3);
    expect(overview.plan.orders.map((order) => [order.stock_code, order.rank, order.signal_date])).toEqual([
      ['000002', 2, '20260722'],
    ]);
    expect((await service.getRuntimeState()).last_signal_date).toBe('20260722');

    await service.overview(market.analysis, market.rankingDate, market.rankings, market.calendar);
    expect((await service.getRuntimeState()).instructions).toHaveLength(1);
  });

  it('fills the available holding slots from the previous-day ranking when no daily entry cap is configured', async () => {
    const now = new Date('2026-07-23T11:00:00+08:00');
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, {
      now: () => now,
      strategy: { maxPositions: 3 },
    });
    const market = context('20260722', [
      ranking('600001', '排行第一', 90, 10, 1),
      ranking('000002', '排行第二', 85, 10, 2),
      ranking('300003', '排行第三', 80, 10, 3),
      ranking('600004', '排行第四', 75, 10, 4),
    ], ['20260722', '20260723']);

    const overview = await service.overview(market.analysis, market.rankingDate, market.rankings, market.calendar);
    expect(overview.plan.max_entries_per_day).toBe(3);
    expect(overview.plan.orders.map((order) => [order.stock_code, order.rank])).toEqual([
      ['600001', 1],
      ['000002', 2],
      ['300003', 3],
    ]);
  });

  it('repairs a missing previous-close plan at the next open before submitting orders', async () => {
    const now = new Date('2026-07-24T09:31:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, {
      stateStore: store,
      now: () => now,
      strategy: { maxEntriesPerDay: 2 },
    });
    const market = context('20260723', [
      ranking('600001', '测试甲', 80, 10, 1),
      ranking('000002', '测试乙', 70, 10, 2),
    ], ['20260723', '20260724']);

    const result = await service.runWindow('open', market);
    expect(result.results.map((order) => order.stock_code)).toEqual(['600001', '000002']);
    expect(broker.placed).toHaveLength(2);
    expect((await service.getRuntimeState()).last_signal_date).toBe('20260723');
  });

  it('keeps automatic execution in the opening window but allows confirmed immediate execution during trading hours', async () => {
    const now = new Date('2026-07-23T11:00:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    const market = context('20260722', [ranking('600001', '测试甲', 80, 10, 1)], ['20260722', '20260723']);

    await expect(service.runWindow('open', market)).rejects.toThrow('开盘执行窗口');
    const result = await service.runWindowConfirmed('open', market);
    expect(result.results.map((order) => order.stock_code)).toEqual(['600001']);
    expect(broker.placed).toHaveLength(1);
  });

  it('generates signals at close, executes them only at the next open, and is idempotent across restarts', async () => {
    let now = new Date('2026-07-23T15:06:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, {
      stateStore: store,
      now: () => now,
      strategy: { maxEntriesPerDay: 2 },
    });
    const market = context('20260723', [
      ranking('600001', '测试甲', 80),
      ranking('000002', '测试乙', 70),
      ranking('300003', '测试丙', 60),
    ], ['20260723', '20260724']);

    const close = await service.runWindow('close', market);
    expect(close.results).toHaveLength(2);
    expect(broker.placed).toHaveLength(0);
    expect((await service.getRuntimeState()).instructions.filter((item) => item.status === 'pending')).toHaveLength(2);

    now = new Date('2026-07-24T09:31:00+08:00');
    const open = await service.runWindow('open', market);
    // 仓位按总分分档缩放（scoreScaledSizing）：80 分 → 系数 0.8 → 10% × 0.8 = 8% 额度 → 800 股。
    // 第二笔在扣除第一笔占用后按剩余现金计算，所以少于第一笔。
    // 这条链路过去是断的 —— positionRatioForScore 只被测试引用，实盘一律用固定 10%（1000 股）。
    expect(open.results.map((order) => [order.side, order.stock_code, order.quantity])).toEqual([
      ['buy', '600001', 800],
      ['buy', '000002', 700],
    ]);
    expect(broker.placed).toHaveLength(2);

    const restarted = new PaperTradingService(broker, { stateStore: store, now: () => now });
    const repeated = await restarted.runWindow('open', market);
    expect(repeated.status).toBe('already_completed');
    expect(broker.placed).toHaveLength(2);
    expect((await restarted.getRuntimeState()).instructions.filter((item) => item.status === 'filled')).toHaveLength(2);
    const cached = await restarted.cachedOverview(analysis, '20260724', [], ['20260723', '20260724'], 'trace-history');
    expect(cached.plan.orders).toHaveLength(0);
    expect(cached.plan.history).toHaveLength(2);
    expect(cached.plan.history.map((item) => item.status)).toEqual(['已成交', '已成交']);
    expect(cached.plan.history.every((item) => item.signal_date === '20260723')).toBe(true);
  });

  it('expires every pending plan after its execution day and never carries it into a later trading day', async () => {
    let now = new Date('2026-07-24T14:59:00+08:00');
    const store = new TestStateStore();
    store.state = {
      ...defaultState('2026-07-23 15:05:00'),
      reference_capital: 100_000,
      last_signal_date: '20260723',
      instructions: [
        {
          id: 'pending-buy',
          side: 'buy',
          stock_code: '000001',
          stock_name: '待买入',
          signal_date: '20260723',
          signal_price: 10,
          quantity: 1_000,
          rank: 1,
          reason: '测试买入计划 次日开盘',
          execution_window: 'open',
          status: 'pending',
          created_at: '2026-07-23 15:05:00',
        },
        {
          id: 'pending-sell',
          side: 'sell',
          stock_code: '600100',
          stock_name: '待卖出',
          signal_date: '20260723',
          signal_price: 10,
          quantity: 1_000,
          reason: '测试卖出计划；次日临近收盘卖出',
          execution_window: 'near_close',
          status: 'pending',
          created_at: '2026-07-23 15:05:00',
        },
      ],
    };
    const broker = new FlowBroker({
      availableCash: 90_000,
      totalAssets: 100_000,
      positions: [{
        stock_code: '600100',
        stock_name: '待卖出',
        shares: 1_000,
        available_shares: 1_000,
        cost_price: 10,
        current_price: 10,
        market_value: 10_000,
        pnl_amount: 0,
        pnl_pct: 0,
      }],
      orders: [],
    });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    const calendar = ['20260723', '20260724', '20260727'];

    const beforeClose = await service.overview(analysis, '20260723', [], calendar);
    expect(beforeClose.plan.orders.map((item) => item.id).sort()).toEqual(['pending-buy', 'pending-sell']);

    now = new Date('2026-07-24T15:01:00+08:00');
    const afterClose = await service.overview(analysis, '20260723', [], calendar);
    expect(afterClose.plan.orders).toHaveLength(0);
    expect(afterClose.plan.history.filter((item) => item.status === '已过期').map((item) => item.id).sort()).toEqual([
      'pending-buy',
      'pending-sell',
    ]);
    expect((await service.getRuntimeState()).instructions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pending-buy', status: 'expired', reason: expect.stringContaining('2026-07-24') }),
      expect.objectContaining({ id: 'pending-sell', status: 'expired', reason: expect.stringContaining('当日未执行') }),
    ]));

    now = new Date('2026-07-27T09:31:00+08:00');
    const laterOpen = await service.runWindow('open', context('20260724', [], calendar));
    expect(laterOpen.results).toHaveLength(0);
    expect(broker.placed).toHaveLength(0);
  });

  describe('过期清算不依赖同花顺、交易日和自动化开关', () => {
    const stalePlanState = (enabled: boolean): PaperTradingRuntimeState => ({
      ...defaultState('2026-07-23 15:05:00'),
      reference_capital: 100_000,
      last_signal_date: '20260723',
      automation: { ...defaultState('2026-07-23 15:05:00').automation, enabled },
      instructions: [{
        id: 'stale-sell',
        side: 'sell',
        stock_code: '000815',
        stock_name: '待卖出',
        signal_date: '20260723',
        signal_price: 10,
        quantity: 1_000,
        reason: '止损信号 -15.42%；次日开盘卖出',
        execution_window: 'open',
        status: 'pending',
        created_at: '2026-07-23 15:05:00',
      }],
    });

    it('同花顺离线、已过收盘时仍把当日未执行计划置为过期', async () => {
      const store = new TestStateStore();
      store.state = stalePlanState(true);
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: store,
        // 执行日 20260724 的 20:00：早已过收盘，且过了 15:20 监控时段
        now: () => new Date('2026-07-24T20:00:00+08:00'),
      });

      expect(await service.expireStalePlans()).toBe(1);
      expect(store.state?.instructions[0]).toMatchObject({
        id: 'stale-sell',
        status: 'expired',
        reason: expect.stringContaining('当日未执行'),
      });
    });

    it('周末也清算上一交易日遗留的计划', async () => {
      const store = new TestStateStore();
      store.state = stalePlanState(true);
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: store,
        now: () => new Date('2026-07-25T11:00:00+08:00'),
      });

      expect(await service.expireStalePlans()).toBe(1);
      expect(store.state?.instructions[0]?.status).toBe('expired');
    });

    it('调度器越过自动化开关、交易日和监控时段三道闸门照常清算', async () => {
      const store = new TestStateStore();
      store.state = stalePlanState(false);
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: store,
        // 周六 20:00：自动化关闭 + 非交易日 + 已过 15:20 监控时段，三道闸门全踩中
        now: () => new Date('2026-07-25T20:00:00+08:00'),
      });

      service.startScheduler();
      try {
        await waitFor(() => store.state?.instructions[0]?.status === 'expired');
      } finally {
        service.stopScheduler();
      }
      expect(store.state?.instructions[0]?.status).toBe('expired');
    });

    it('没有到期计划时不写盘', async () => {
      const store = new TestStateStore();
      store.state = stalePlanState(true);
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: store,
        // 执行日当天 09:40，窗口还没关，不该过期
        now: () => new Date('2026-07-24T09:40:00+08:00'),
      });
      const before = store.saves;

      expect(await service.expireStalePlans()).toBe(0);
      expect(store.saves).toBe(before);
      expect(store.state?.instructions[0]?.status).toBe('pending');
    });

    it('重复清算是幂等的，只记一条过期事件', async () => {
      const store = new TestStateStore();
      store.state = stalePlanState(true);
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: store,
        now: () => new Date('2026-07-24T20:00:00+08:00'),
      });

      expect(await service.expireStalePlans()).toBe(1);
      expect(await service.expireStalePlans()).toBe(0);
      expect(store.state?.events.filter((event) => event.type === 'plans_expired')).toHaveLength(1);
    });
  });

  describe('窗口失败退避', () => {
    it('盘中窗口退避压到 2 分钟以内，盘后窗口拉到 15 分钟', () => {
      expect([1, 2, 3, 4, 5].map((failures) => windowRetryDelayMs('near_close', failures)))
        .toEqual([20_000, 40_000, 80_000, 120_000, 120_000]);
      expect([1, 2, 3, 4, 5, 6, 7].map((failures) => windowRetryDelayMs('close', failures)))
        .toEqual([20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000]);
    });

    it('临收盘 14:57-15:00 内可重试 3 次以上（原固定 5 分钟退避只有 1 次）', () => {
      let elapsed = 0;
      let attempts = 1;
      while (elapsed + windowRetryDelayMs('near_close', attempts) < 3 * 60_000) {
        elapsed += windowRetryDelayMs('near_close', attempts);
        attempts += 1;
      }
      expect(attempts).toBeGreaterThanOrEqual(3);
    });
  });

  describe('同花顺自动拉起', () => {
    /** 记录 ensureReady 与券商调用的先后，用来断言"下单前已就绪"。 */
    class ReadinessSpy {
      readonly calls: Array<{ reason: string; timeoutMs?: number }> = [];
      ready = true;
      message?: string;

      ensureReady = async (reason: string, options?: { timeoutMs?: number }) => {
        this.calls.push({ reason, timeoutMs: options?.timeoutMs });
        this.trace?.push(`ensureReady:${reason}`);
        return { ready: this.ready, launched: false, message: this.message };
      };

      trace?: string[];
    }

    const account = () => ({
      availableCash: 90_000,
      totalAssets: 100_000,
      positions: [],
      orders: [],
    });

    it('runWindow 在读账户之前先保证同花顺就绪', async () => {
      const trace: string[] = [];
      const readiness = new ReadinessSpy();
      readiness.trace = trace;
      const broker = new FlowBroker(account());
      const originalSnapshot = broker.snapshot.bind(broker);
      broker.snapshot = async (...args) => {
        trace.push('broker:snapshot');
        return originalSnapshot(...args);
      };
      const service = new PaperTradingService(broker, {
        stateStore: new TestStateStore(),
        thsReadiness: readiness,
        now: () => new Date('2026-07-24T09:35:00+08:00'),
      });

      await service.runWindow('open', context('20260723', [], ['20260723', '20260724']));

      expect(trace[0]).toBe('ensureReady:window:open');
      expect(trace).toContain('broker:snapshot');
      expect(trace.indexOf('ensureReady:window:open')).toBeLessThan(trace.indexOf('broker:snapshot'));
    });

    it('临收盘窗口只给 45s 预算，其余窗口给 120s', async () => {
      const readiness = new ReadinessSpy();
      const service = new PaperTradingService(new FlowBroker(account()), {
        stateStore: new TestStateStore(),
        thsReadiness: readiness,
        now: () => new Date('2026-07-24T14:58:00+08:00'),
      });
      await service.runWindow('near_close', context('20260723', [], ['20260723', '20260724']));
      expect(readiness.calls.at(-1)).toMatchObject({ reason: 'window:near_close', timeoutMs: 45_000 });

      expect(thsReadyTimeoutMs('open')).toBe(120_000);
      expect(thsReadyTimeoutMs('close')).toBe(120_000);
      expect(thsReadyTimeoutMs('post_close')).toBe(120_000);
    });

    it('monitorAccount 不拉起同花顺', async () => {
      const readiness = new ReadinessSpy();
      const service = new PaperTradingService(new FlowBroker(account()), {
        stateStore: new TestStateStore(),
        thsReadiness: readiness,
        now: () => new Date('2026-07-24T10:30:00+08:00'),
      });

      await service.monitorAccount('trace-monitor', 'manual_monitor');

      expect(readiness.calls).toHaveLength(0);
    });

    it('同花顺拉不起来时窗口照常尝试，失败原因保留券商原始报错', async () => {
      const readiness = new ReadinessSpy();
      readiness.ready = false;
      readiness.message = 'LOGIN_PENDING|等待主交易界面超时';
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: new TestStateStore(),
        thsReadiness: readiness,
        now: () => new Date('2026-07-24T09:35:00+08:00'),
      });

      await expect(service.runWindow('open', context('20260723', [], ['20260723', '20260724'])))
        .rejects.toThrow('同花顺尚未运行');
      expect(readiness.calls).toHaveLength(1);
    });

    it('预热区间 09:25-09:31 / 14:50-14:57 / 15:03-15:05 各覆盖一次', () => {
      expect(thsWarmupSlot(9 * 60 + 24)).toBeNull();
      expect(thsWarmupSlot(9 * 60 + 25)).toMatchObject({ slot: 'open', timeoutMs: 120_000 });
      expect(thsWarmupSlot(9 * 60 + 30)).toMatchObject({ slot: 'open' });
      expect(thsWarmupSlot(9 * 60 + 31)).toBeNull();
      expect(thsWarmupSlot(14 * 60 + 50)).toMatchObject({ slot: 'near_close', timeoutMs: 120_000 });
      expect(thsWarmupSlot(14 * 60 + 57)).toBeNull();
      expect(thsWarmupSlot(15 * 60 + 3)).toMatchObject({ slot: 'close', timeoutMs: 90_000 });
      expect(thsWarmupSlot(15 * 60 + 5)).toBeNull();
    });

    it('调度器在开盘前预热一次，同日重复 tick 不再预热', async () => {
      const readiness = new ReadinessSpy();
      const store = new TestStateStore();
      store.state = {
        ...defaultState('2026-07-23 15:05:00'),
        automation: { ...defaultState('2026-07-23 15:05:00').automation, enabled: true },
      };
      const service = new PaperTradingService(new OfflineBroker(), {
        stateStore: store,
        thsReadiness: readiness,
        // 09:26：在 open 预热区间内，且早于 09:31 的 due 窗口
        now: () => new Date('2026-07-24T09:26:00+08:00'),
      });
      service.setTradingCalendar(['20260723', '20260724']);

      service.startScheduler();
      try {
        await waitFor(() => readiness.calls.length > 0);
        // 多跑几个 tick，确认不会重复预热
        await new Promise((resolve) => { setTimeout(resolve, 60); });
      } finally {
        service.stopScheduler();
      }

      expect(readiness.calls).toEqual([{ reason: 'warmup:open', timeoutMs: 120_000 }]);
    });
  });

  it('uses the five-trading-day exit rule and schedules strong-market buys at open and sells near close', async () => {
    let now = new Date('2026-07-17T15:10:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({
      availableCash: 90_000,
      totalAssets: 100_000,
      positions: [{
        stock_code: '600100',
        stock_name: '测试持仓',
        shares: 1000,
        available_shares: 1000,
        cost_price: 10,
        current_price: 10,
        market_value: 10_000,
        pnl_amount: 0,
        pnl_pct: 0,
      }],
      orders: [],
    });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    await service.overview(analysis, '20260717', [], ['20260717']);

    const calendar = ['20260717', '20260720', '20260721', '20260722', '20260723', '20260724', '20260727'];
    now = new Date('2026-07-24T15:06:00+08:00');
    const close = await service.runWindow('close', context('20260724', [ranking('000001', '新候选', 80)], calendar));
    expect(close.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: 'sell', stock_code: '600100', execution_window: 'near_close' }),
      expect.objectContaining({ side: 'buy', stock_code: '000001', execution_window: 'open' }),
    ]));

    now = new Date('2026-07-27T09:31:00+08:00');
    await service.runWindow('open', context('20260724', [], calendar));
    expect(broker.placed).toEqual([
      expect.objectContaining({ side: 'buy', stock_code: '000001', execution_window: 'open' }),
    ]);

    now = new Date('2026-07-27T14:57:00+08:00');
    await service.runWindow('near_close', context('20260724', [], calendar));
    expect(broker.placed[1]).toMatchObject({ side: 'sell', stock_code: '600100', execution_window: 'near_close' });
    expect(broker.account.positions.some((position) => position.stock_code === '600100')).toBe(false);
  });

  it('schedules weak-market sells at open and buys near close, even when limit-up sentiment is hot', async () => {
    let now = new Date('2026-07-22T15:10:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({
      availableCash: 90_000,
      totalAssets: 100_000,
      positions: [{
        stock_code: '600100',
        stock_name: '待止损持仓',
        shares: 1000,
        available_shares: 1000,
        cost_price: 10,
        current_price: 10,
        market_value: 10_000,
        pnl_amount: 0,
        pnl_pct: 0,
      }],
      orders: [],
    });
    const service = new PaperTradingService(broker, {
      stateStore: store,
      now: () => now,
      strategy: { maxPositions: 1, maxEntriesPerDay: 1 },
    });
    await service.overview(analysis, '20260722', [], ['20260722']);

    const weakAnalysis = analysisForTiming('hot', 6);
    const market = context('20260722', [
      ranking('600100', '待止损持仓', 90, 9, 1),
      ranking('000001', '替补候选', 80, 10, 2),
    ], ['20260722', '20260723'], weakAnalysis);
    now = new Date('2026-07-23T11:00:00+08:00');
    const overview = await service.overview(market.analysis, market.rankingDate, market.rankings, market.calendar);
    expect(overview.plan.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: 'sell', execution_window: 'open', status: '待开盘执行' }),
      expect.objectContaining({ side: 'buy', execution_window: 'near_close', status: '待临收盘执行' }),
    ]));

    now = new Date('2026-07-23T09:31:00+08:00');
    await service.runWindow('open', market);
    expect(broker.placed).toEqual([
      expect.objectContaining({ side: 'sell', stock_code: '600100', execution_window: 'open' }),
    ]);

    now = new Date('2026-07-23T14:57:00+08:00');
    await service.runWindow('near_close', market);
    expect(broker.placed[1]).toMatchObject({ side: 'buy', stock_code: '000001', execution_window: 'near_close' });
  });

  it('does not reuse a strong-market near-close sell slot for an earlier opening buy', async () => {
    let now = new Date('2026-07-22T15:10:00+08:00');
    const broker = new FlowBroker({
      availableCash: 90_000,
      totalAssets: 100_000,
      positions: [{
        stock_code: '600100',
        stock_name: '待止盈持仓',
        shares: 1000,
        available_shares: 1000,
        cost_price: 10,
        current_price: 10,
        market_value: 10_000,
        pnl_amount: 0,
        pnl_pct: 0,
      }],
      orders: [],
    });
    const service = new PaperTradingService(broker, {
      now: () => now,
      strategy: { maxPositions: 1 },
    });
    await service.overview(analysis, '20260722', [], ['20260722']);

    now = new Date('2026-07-23T11:00:00+08:00');
    const overview = await service.overview(analysis, '20260722', [
      ranking('600100', '待止盈持仓', 90, 12, 1),
      ranking('000001', '替补候选', 80, 10, 2),
    ], ['20260722', '20260723']);
    expect(overview.plan.orders).toEqual([
      expect.objectContaining({ side: 'sell', stock_code: '600100', execution_window: 'near_close' }),
    ]);
  });

  it('creates stop-loss, take-profit, and max-hold sell plans from the previous close', async () => {
    let now = new Date('2026-07-17T15:10:00+08:00');
    const store = new TestStateStore();
    const positions = [
      ['600101', '止损持仓'],
      ['600102', '止盈持仓'],
      ['600103', '到期持仓'],
    ].map(([stock_code, stock_name]) => ({
      stock_code,
      stock_name,
      shares: 1000,
      available_shares: 1000,
      cost_price: 10,
      current_price: 10,
      market_value: 10_000,
      pnl_amount: 0,
      pnl_pct: 0,
    }));
    const broker = new FlowBroker({ availableCash: 70_000, totalAssets: 100_000, positions, orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    await service.overview(analysis, '20260717', [], ['20260717']);

    const calendar = ['20260717', '20260720', '20260721', '20260722', '20260723', '20260724', '20260727'];
    now = new Date('2026-07-27T11:00:00+08:00');
    const overview = await service.overview(analysis, '20260724', [
      ranking('600101', '止损持仓', 90, 9, 1),
      ranking('600102', '止盈持仓', 80, 12, 2),
      ranking('600103', '到期持仓', 70, 10, 3),
    ], calendar);
    const sells = overview.plan.orders.filter((order) => order.side === 'sell');
    expect(sells).toHaveLength(3);
    expect(sells.find((order) => order.stock_code === '600101')?.reason).toContain('止损信号');
    expect(sells.find((order) => order.stock_code === '600102')?.reason).toContain('止盈信号');
    expect(sells.find((order) => order.stock_code === '600103')?.reason).toContain('持仓满 5 日');
  });

  it('lets confirmed immediate execution override a pending near-close plan during trading hours', async () => {
    const now = new Date('2026-07-23T11:00:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    const weakMarket = context(
      '20260722',
      [ranking('600001', '临收盘候选', 80, 10, 1)],
      ['20260722', '20260723'],
      analysisForTiming('hot', 1),
      -0.5,
    );

    const overview = await service.overview(
      weakMarket.analysis,
      weakMarket.rankingDate,
      weakMarket.rankings,
      weakMarket.calendar,
      'trace-immediate-average',
      weakMarket.marketAverageChange,
    );
    expect(overview.plan.orders[0]).toMatchObject({ execution_window: 'near_close', status: '待临收盘执行' });
    const result = await service.runWindowConfirmed('open', weakMarket);
    expect(result.results[0]).toMatchObject({ stock_code: '600001', execution_window: 'near_close' });
    expect(broker.placed).toHaveLength(1);
  });

  it('does not write a duplicate backfill audit when the same signal date is viewed again', async () => {
    const now = new Date('2026-07-23T11:00:00+08:00');
    const store = new TestStateStore();
    const audit = new RecordingAudit();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, audit, now: () => now });
    const market = context('20260722', [ranking('600001', '测试甲', 80)], ['20260722', '20260723']);

    await service.overview(market.analysis, market.rankingDate, market.rankings, market.calendar);
    await service.overview(market.analysis, market.rankingDate, market.rankings, market.calendar);
    expect(audit.records.filter((record) => record.event === 'previous_close_plan_backfilled')).toHaveLength(1);
  });

  it('restores pending after a retryable submission error and retries on the next window run', async () => {
    let now = new Date('2026-07-23T15:06:00+08:00');
    const store = new TestStateStore();
    const broker = new FailingBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    const market = context('20260723', [ranking('600001', '测试甲', 80)], ['20260723', '20260724']);
    await service.runWindow('close', market);

    now = new Date('2026-07-24T09:31:00+08:00');
    const firstRun = await service.runWindow('open', market);
    expect(firstRun.status).toBe('completed');
    expect(broker.attempts).toBe(1);
    const instruction = (await service.getRuntimeState()).instructions[0];
    expect(instruction).toMatchObject({
      status: 'pending',
      broker_status: expect.stringContaining('上次提交失败'),
    });

    const restarted = new PaperTradingService(broker, { stateStore: store, now: () => now });
    await expect(restarted.runWindow('open', market)).resolves.toMatchObject({ status: 'completed' });
    expect(broker.attempts).toBe(2);
  });

  it('normalizes legacy retryable uncertain instructions when state is loaded', async () => {
    const store = new TestStateStore();
    store.state = {
      ...defaultState('2026-07-29 09:00:00'),
      instructions: [{
        id: 'legacy-uncertain',
        side: 'sell',
        stock_code: '600722',
        stock_name: '金牛化工',
        signal_date: '20260728',
        signal_price: 9.26,
        quantity: 1200,
        reason: '止损信号 -19.34%；次日开盘卖出',
        execution_window: 'open',
        status: 'uncertain',
        created_at: '2026-07-28 23:35:59',
        submitted_at: '2026-07-29 10:42:22',
        broker_status: '提交结果不确定：未识别到“确定卖出”按钮，界面结构可能已变化 (-2700)',
      }],
    };
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, {
      stateStore: store,
      now: () => new Date('2026-07-29T10:00:00+08:00'),
    });
    expect((await service.getRuntimeState()).instructions[0]).toMatchObject({
      status: 'pending',
      submitted_at: undefined,
      broker_status: expect.stringContaining('上次提交失败'),
    });
  });

  it('reconciles stale uncertain sells back to pending when Tonghuashun has no matching order', async () => {
    const now = new Date('2026-07-24T09:31:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({
      availableCash: 100_000,
      totalAssets: 110_000,
      positions: [{
        stock_code: '600722',
        stock_name: '金牛化工',
        shares: 1200,
        available_shares: 1200,
        cost_price: 11.48,
        current_price: 10.19,
        market_value: 12228,
        pnl_amount: -1500,
        pnl_pct: -11,
      }],
      orders: [],
    });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now, enforceTradingWindows: false });
    store.state = {
      ...defaultState('2026-07-24 09:00:00'),
      instructions: [{
        id: 'sell-600722',
        side: 'sell',
        stock_code: '600722',
        stock_name: '金牛化工',
        signal_date: '20260723',
        signal_price: 9.26,
        quantity: 1200,
        reason: '止损信号 -19.34%；次日开盘卖出',
        execution_window: 'open',
        status: 'uncertain',
        created_at: '2026-07-23 15:05:00',
        broker_status: '提交结果不确定：委托已提交但回查失败：600722',
      }],
      tracked_positions: [{
        stock_code: '600722',
        stock_name: '金牛化工',
        entry_date: '20260720',
        entry_price: 11.48,
        shares: 1200,
        source: 'strategy',
      }],
    };
    await service.monitorAccount('trace-reconcile', 'test_reconcile');
    expect((await service.getRuntimeState()).instructions[0]).toMatchObject({
      status: 'pending',
      broker_status: '同花顺无对应委托，已恢复待执行',
    });
  });

  it('does not duplicate close signals when the close window is run twice on the same day', async () => {
    const now = new Date('2026-07-23T15:06:00+08:00');
    const store = new TestStateStore();
    const broker = new FlowBroker({
      availableCash: 100_000,
      totalAssets: 100_000,
      positions: [{
        stock_code: '600101',
        stock_name: '测试乙',
        shares: 1000,
        available_shares: 1000,
        cost_price: 10,
        current_price: 9,
        market_value: 9000,
        pnl_amount: -1000,
        pnl_pct: -10,
      }],
      orders: [],
    });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now, enforceTradingWindows: false });
    const market = context('20260723', [ranking('600001', '测试甲', 80)], ['20260723', '20260724']);

    await service.runWindow('close', market);
    const firstCount = (await service.getRuntimeState()).instructions.length;
    const state = await service.getRuntimeState();
    state.completed_windows = {};
    await store.save(state);
    await service.runWindow('close', market);
    const secondCount = (await service.getRuntimeState()).instructions.length;

    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toBe(firstCount);
  });

  it('fails closed before AppleScript execution when the pre-order audit record cannot be persisted', async () => {
    let now = new Date('2026-07-23T15:06:00+08:00');
    const store = new TestStateStore();
    const audit = new OrderStartFailingAudit();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, audit, now: () => now });
    const market = context('20260723', [ranking('600001', '测试甲', 80)], ['20260723', '20260724']);
    await service.runWindow('close', market);

    now = new Date('2026-07-24T09:31:00+08:00');
    await expect(service.runWindow('open', market)).rejects.toThrow('审计日志目录不可写');
    expect(broker.placed).toHaveLength(0);
    expect((await service.getRuntimeState()).instructions[0]).toMatchObject({ status: 'pending' });
  });

  it('records semantic Tonghuashun account changes for monitoring and diagnosis', async () => {
    const now = new Date('2026-07-23T15:10:00+08:00');
    const audit = new RecordingAudit();
    const broker = new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { audit, now: () => now });
    await service.overview(analysis, '20260723', [], ['20260723'], 'trace-overview');

    broker.account.availableCash = 90_000;
    broker.account.positions.push({
      stock_code: '600001',
      stock_name: '测试新增',
      shares: 1000,
      available_shares: 0,
      cost_price: 10,
      current_price: 10,
      market_value: 10_000,
      pnl_amount: 0,
      pnl_pct: 0,
    });
    await service.monitorAccount('trace-monitor', 'test_monitor');

    const changed = audit.records.find((record) => record.component === 'account_monitor' && record.event === 'account_changed');
    expect(changed?.details?.traceId).toBe('trace-monitor');
    const data = changed?.details?.data as { changes: Array<{ type: string; stock_code?: string }> };
    expect(data.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'available_cash_changed' }),
      expect.objectContaining({ type: 'position_added', stock_code: '600001' }),
    ]));
  });

  it('uses account-only sync outside trading session and skips strategy backfill', async () => {
    const now = new Date('2026-07-25T20:00:00+08:00');
    const audit = new RecordingAudit();
    let accountOnlyCalls = 0;
    let fullSnapshotCalls = 0;
    const broker: SimulatedBroker = {
      async snapshot() {
        fullSnapshotCalls += 1;
        return { availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] };
      },
      async snapshotAccountOnly() {
        accountOnlyCalls += 1;
        return { availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] };
      },
      async quote() { return 10; },
      async placeOrder(order: PaperOrder) {
        return { verified: true, brokerOutput: `ORDER_VERIFIED|${order.stock_code}` };
      },
      async cancelOrder() {
        return { verified: true, brokerOutput: 'CANCEL_VERIFIED' };
      },
    };
    const service = new PaperTradingService(broker, { audit, now: () => now });
    const context: PaperMarketContext = {
      analysis,
      rankingDate: '20260724',
      rankings: [ranking('600001', '测试', 80)],
      calendar: ['20260722', '20260723', '20260724'],
      marketAverageChange: -1,
      limitUpRecords: [],
    };
    await service.overview(context.analysis, context.rankingDate, context.rankings, context.calendar, 'trace-account-only', context.marketAverageChange, context.limitUpRecords);

    expect(isAccountSyncOnlyPeriod(shanghaiClock(now), context.calendar ?? [])).toBe(true);
    expect(accountOnlyCalls).toBe(1);
    expect(fullSnapshotCalls).toBe(0);
    expect(audit.records.some((record) => record.event === 'previous_close_plan_backfilled')).toBe(false);
    expect(audit.records.some((record) => record.event === 'account_only_sync')).toBe(true);
  });

  it('applies backtest strategy parameters and persists them in runtime state', async () => {
    const stateStore = new TestStateStore();
    const audit = new RecordingAudit();
    const service = new PaperTradingService(new FlowBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] }), {
      stateStore,
      audit,
      now: () => new Date('2026-07-24T10:00:00+08:00'),
    });

    const applied = await service.applyBacktestStrategy('test-run-001', {
      max_hold_days: 7,
      max_positions: 4,
      position_size_pct: 15,
      take_profit_pct: 20,
      stop_loss_pct: -8,
      max_positions_per_day: 2,
    }, 'trace-apply');

    expect(applied).toMatchObject({
      ok: true,
      run_id: 'test-run-001',
      strategy: {
        maxHoldDays: 7,
        maxPositions: 4,
        positionSizePct: 15,
        takeProfitPct: 20,
        stopLossPct: -8,
        maxEntriesPerDay: 2,
      },
      plan: {
        max_hold_days: 7,
        max_positions: 4,
        position_size_pct: 15,
        take_profit_pct: 20,
        stop_loss_pct: -8,
        max_entries_per_day: 2,
      },
    });
    expect(stateStore.state?.applied_backtest_run_id).toBe('test-run-001');
    expect(stateStore.state?.strategy_config).toMatchObject({
      maxHoldDays: 7,
      maxPositions: 4,
      positionSizePct: 15,
      takeProfitPct: 20,
      stopLossPct: -8,
      maxEntriesPerDay: 2,
    });
    expect(audit.records.some((record) => record.event === 'strategy_applied_from_backtest')).toBe(true);
  });

  it('rejects immediate auto window outside trading session or on non-trading days', () => {
    const calendar = ['20260722', '20260723', '20260724'];
    expect(immediateAutoWindowRejection(shanghaiClock(new Date('2026-07-25T10:00:00+08:00')), calendar))
      .toBe('当前不是交易日（周末），无法立即执行');
    expect(immediateAutoWindowRejection(shanghaiClock(new Date('2026-07-21T10:00:00+08:00')), calendar))
      .toBe('当前不是交易日（节假日），无法立即执行');
    expect(immediateAutoWindowRejection(shanghaiClock(new Date('2026-07-24T08:00:00+08:00')), calendar))
      .toBe('当前不在交易时段（09:25 后方可执行）');
    expect(immediateAutoWindowRejection(shanghaiClock(new Date('2026-07-24T20:00:00+08:00')), calendar)).toBeNull();
    expect(immediateAutoWindowRejection(shanghaiClock(new Date('2026-07-24T10:00:00+08:00')), calendar)).toBeNull();
  });

  it('resolves auto trading window from shanghai clock', () => {
    expect(resolveAutoTradingWindow(shanghaiClock(new Date('2026-07-24T09:30:00+08:00')))).toBe('open');
    expect(resolveAutoTradingWindow(shanghaiClock(new Date('2026-07-24T11:00:00+08:00')))).toBe('open');
    expect(resolveAutoTradingWindow(shanghaiClock(new Date('2026-07-24T14:55:00+08:00')))).toBe('open');
    expect(resolveAutoTradingWindow(shanghaiClock(new Date('2026-07-24T14:57:00+08:00')))).toBe('near_close');
    expect(resolveAutoTradingWindow(shanghaiClock(new Date('2026-07-24T15:02:00+08:00')))).toBe('close');
    expect(resolveAutoTradingWindow(shanghaiClock(new Date('2026-07-24T15:10:00+08:00')))).toBe('post_close');
  });

  it('detects trading days from the shared market calendar', () => {
    const calendar = ['20260722', '20260723', '20260724'];
    expect(isTradingDay(shanghaiClock(new Date('2026-07-25T10:00:00+08:00')), calendar)).toBe(false);
    expect(isTradingDay(shanghaiClock(new Date('2026-07-24T10:00:00+08:00')), calendar)).toBe(true);
    expect(isTradingDay(
      shanghaiClock(new Date('2026-07-27T10:00:00+08:00')),
      calendar,
      { calendarRefreshed: true },
    )).toBe(false);
  });

  it('resolves the first trading day after a signal from the calendar or weekday fallback', () => {
    expect(nextTradingDateAfter('20260724', ['20260724', '20260727', '20260728'])).toBe('20260727');
    expect(nextTradingDateAfter('20260724')).toBe('20260727');
    expect(nextTradingDateAfter('invalid')).toBeNull();
  });
});
