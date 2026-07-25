import { describe, expect, it } from 'vitest';
import type { AuditDetails, AuditLevel, AuditLoggerLike } from '../server/audit-log.js';
import {
  PaperTradingService,
  type PaperMarketContext,
  type PaperTradingStateStore,
} from '../server/paper-trading.js';
import type { SimulatedAccountSnapshot, SimulatedBroker } from '../server/ths-simulated-broker.js';
import type { AnalysisData, PaperOrder, PaperTradingRuntimeState, RankingRow } from '../src/types.js';

class TestStateStore implements PaperTradingStateStore {
  state: PaperTradingRuntimeState | null = null;

  async load() {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: PaperTradingRuntimeState) {
    this.state = structuredClone(state);
  }
}

class RecordingAudit implements AuditLoggerLike {
  records: Array<{ level: AuditLevel; component: string; event: string; details?: AuditDetails }> = [];

  debug(component: string, event: string, details?: AuditDetails) { return this.add('debug', component, event, details); }
  info(component: string, event: string, details?: AuditDetails) { return this.add('info', component, event, details); }
  warn(component: string, event: string, details?: AuditDetails) { return this.add('warn', component, event, details); }
  error(component: string, event: string, details?: AuditDetails) { return this.add('error', component, event, details); }

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
    expect(open.results.map((order) => [order.side, order.stock_code, order.quantity])).toEqual([
      ['buy', '600001', 1000],
      ['buy', '000002', 800],
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

    now = new Date('2026-07-27T14:55:00+08:00');
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

    now = new Date('2026-07-23T14:55:00+08:00');
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

  it('persists an uncertain instruction and never retries it automatically after an execution error', async () => {
    let now = new Date('2026-07-23T15:06:00+08:00');
    const store = new TestStateStore();
    const broker = new FailingBroker({ availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] });
    const service = new PaperTradingService(broker, { stateStore: store, now: () => now });
    const market = context('20260723', [ranking('600001', '测试甲', 80)], ['20260723', '20260724']);
    await service.runWindow('close', market);

    now = new Date('2026-07-24T09:31:00+08:00');
    await expect(service.runWindow('open', market)).rejects.toThrow('AppleScript 回查超时');
    expect(broker.attempts).toBe(1);
    expect((await service.getRuntimeState()).instructions[0]).toMatchObject({ status: 'uncertain' });

    const restarted = new PaperTradingService(broker, { stateStore: store, now: () => now });
    await expect(restarted.runWindow('open', market)).rejects.toThrow('提交结果不确定');
    expect(broker.attempts).toBe(1);
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
    expect((await service.getRuntimeState()).instructions[0]).toMatchObject({ status: 'submitting' });
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
});
