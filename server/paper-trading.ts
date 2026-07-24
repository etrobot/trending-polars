import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AnalysisData,
  AutomationState,
  PaperAccountObservation,
  PaperOrder,
  PaperOverview,
  PlanExecutionWindow,
  PaperStrategyInstruction,
  PaperTrackedPosition,
  PaperTradingEvent,
  PaperTradingRuntimeState,
  RankingRow,
  TradingWindow,
} from '../src/types.js';
import { guardDetachedPromise, NOOP_AUDIT_LOGGER, type AuditLoggerLike } from './audit-log.js';
import { round } from './format.js';
import {
  calculateEntrySize,
  createT1StrategyConfig,
  DEFAULT_T1_STRATEGY,
  exitSignalReason,
  rankEntryCandidates,
  tradingDayDistance,
  type T1StrategyConfig,
} from './trading-strategy.js';
import {
  ThsSimulatedBroker,
  type BrokerActionResult,
  type BrokerCallContext,
  type SimulatedAccountSnapshot,
  type SimulatedBroker,
} from './ths-simulated-broker.js';

export const PAPER_ENGINE_VERSION = 'node-t1-live-v1';

export interface PaperMarketContext {
  analysis: AnalysisData;
  rankingDate: string;
  rankings: RankingRow[];
  calendar?: string[];
  /** 同花顺 block_top 的权威涨停记录。 */
  limitUpRecords?: Array<{ date: string; stock_code: string }>;
  /** 上一交易日全市场平均涨跌幅；有值时优先用于判断强弱。 */
  marketAverageChange?: number;
}

export interface PaperTradingStateStore {
  load(): Promise<PaperTradingRuntimeState | null>;
  save(state: PaperTradingRuntimeState): Promise<void>;
}

export interface PaperTradingServiceOptions {
  stateStore?: PaperTradingStateStore;
  marketDataProvider?: (window: TradingWindow, traceId: string) => Promise<PaperMarketContext>;
  strategy?: Partial<T1StrategyConfig>;
  now?: () => Date;
  schedulerIntervalMs?: number;
  accountMonitorIntervalMs?: number;
  enforceTradingWindows?: boolean;
  audit?: AuditLoggerLike;
}

interface WindowRunResult {
  ok: true;
  window: TradingWindow;
  trading_date: string;
  status: 'completed' | 'already_completed';
  results: PaperOrder[];
  message: string;
}

interface RunWindowOptions {
  trigger?: 'scheduled' | 'manual' | 'immediate';
}

class MemoryPaperTradingStateStore implements PaperTradingStateStore {
  private value: PaperTradingRuntimeState | null = null;

  async load() {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(state: PaperTradingRuntimeState) {
    this.value = structuredClone(state);
  }
}

function compactDate(value: string): string {
  return value.replaceAll('-', '').slice(0, 8);
}

function exactLimitUpCodes(context: PaperMarketContext, date: string): Set<string> {
  const normalizedDate = compactDate(date);
  return new Set((context.limitUpRecords ?? [])
    .filter((record) => compactDate(record.date) === normalizedDate)
    .map((record) => record.stock_code));
}


function displayDate(value: string): string {
  const date = compactDate(value);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function shanghaiClock(date: Date): { date: string; minute: number; weekday: number; timestamp: string } {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const compact = `${parts.year}${parts.month}${parts.day}`;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00+08:00`).getUTCDay();
  return {
    date: compact,
    minute,
    weekday,
    timestamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function defaultAutomation(): AutomationState {
  return {
    enabled: false,
    paused_today: false,
    next_window: '下一窗口：交易日 09:31 开盘执行',
  };
}

function defaultState(timestamp: string): PaperTradingRuntimeState {
  return {
    schema_version: 1,
    engine_version: PAPER_ENGINE_VERSION,
    automation: defaultAutomation(),
    reference_capital: null,
    completed_windows: {},
    instructions: [],
    tracked_positions: [],
    events: [],
    updated_at: timestamp,
  };
}

function isActiveInstruction(instruction: PaperStrategyInstruction): boolean {
  return ['pending', 'submitting', 'submitted', 'uncertain'].includes(instruction.status);
}

function instructionStatusLabel(instruction: PaperStrategyInstruction): string {
  const pendingLabel = instruction.execution_window === 'near_close' ? '待临收盘执行' : '待开盘执行';
  return ({
    pending: pendingLabel,
    submitting: '提交中',
    submitted: '已提交',
    uncertain: '结果不确定',
    filled: '已成交',
    skipped: '已跳过',
    failed: '失败',
    cancelled: '已撤',
  } as Record<string, string>)[instruction.status] ?? instruction.status;
}

interface MarketTimingAssessment {
  weak: boolean;
  sentiment: string;
  marketAverageChange?: number;
  validIndices: number;
  riskIndices: number;
  bullishIndices: number;
  broadRiskIndices: number;
  reason: string;
}

/**
 * 用指数状态决定成交时序，情绪只作为没有指数数据时的兜底。
 * state_id 6/7 是现有分析流程定义的风险状态，1/2/3 是偏强状态；
 * 这样“行情不好”不会因为涨停板情绪较热而误判成强市。
 */
function assessMarketTiming(context: PaperMarketContext): MarketTimingAssessment {
  const sentiment = String(context.analysis.sentiment?.sentiment ?? 'cold');
  const marketAverageChange = Number(context.marketAverageChange);
  const hasMarketAverage = Number.isFinite(marketAverageChange);
  const indices = (context.analysis.indices ?? []).filter((item) => {
    const stateId = Number(item.state?.state_id ?? 0);
    return stateId >= 1 && stateId <= 7;
  });
  const riskIndices = indices.filter((item) => [6, 7].includes(Number(item.state?.state_id ?? 0))).length;
  const bullishIndices = indices.filter((item) => [1, 2, 3].includes(Number(item.state?.state_id ?? 0))).length;
  const broadCodes = new Set(['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000905', 'sh000016', 'sh000688']);
  const broadRiskIndices = indices.filter((item) => (
    broadCodes.has(String(item.code).toLowerCase())
    && [6, 7].includes(Number(item.state?.state_id ?? 0))
  )).length;
  const riskThreshold = Math.max(1, Math.ceil(indices.length * 0.3));
  const weakByFallback = sentiment === 'cold'
    || broadRiskIndices > 0
    || (indices.length > 0 && riskIndices >= riskThreshold && riskIndices >= bullishIndices);
  const weak = hasMarketAverage ? marketAverageChange <= 0 : weakByFallback;
  const reason = hasMarketAverage
    ? `上一交易日全市场平均涨跌幅 ${round(marketAverageChange, 2)}%`
    : indices.length === 0
      ? `指数数据不足，按情绪 ${sentiment} 判断`
      : `指数风险 ${riskIndices}/${indices.length}、偏强 ${bullishIndices}/${indices.length}，情绪 ${sentiment}`;
  return {
    weak,
    sentiment,
    marketAverageChange: hasMarketAverage ? marketAverageChange : undefined,
    validIndices: indices.length,
    riskIndices,
    bullishIndices,
    broadRiskIndices,
    reason,
  };
}

function isWeakMarket(context: PaperMarketContext): boolean {
  return assessMarketTiming(context).weak;
}

function executionWindowFor(side: 'buy' | 'sell', context: PaperMarketContext): PlanExecutionWindow {
  if (isWeakMarket(context)) return side === 'sell' ? 'open' : 'near_close';
  return side === 'buy' ? 'open' : 'near_close';
}

function executionWindowLabel(window: PlanExecutionWindow): string {
  return window === 'open' ? '次日开盘' : '次日临近收盘';
}

function withExecutionTiming(
  reason: string,
  side: 'buy' | 'sell',
  executionWindow: PlanExecutionWindow,
): string {
  const base = reason
    .replace(/[； ]?次日(?:开盘|临近收盘)(?:买入|卖出)?/g, '')
    .trim();
  return side === 'sell'
    ? `${base}；${executionWindowLabel(executionWindow)}卖出`
    : `${base} ${executionWindowLabel(executionWindow)}`;
}

export class PaperTradingService extends EventEmitter {
  private overviewInFlight: Promise<PaperOverview> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private statePromise: Promise<PaperTradingRuntimeState> | null = null;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private schedulerTickInFlight: Promise<void> | null = null;
  private schedulerRetryAfter = 0;
  private monitorRetryAfter = 0;
  private lastMonitorAt = 0;
  private readonly stateStore: PaperTradingStateStore;
  private readonly strategy: T1StrategyConfig;
  private readonly now: () => Date;
  private readonly schedulerIntervalMs: number;
  private readonly accountMonitorIntervalMs: number;
  private readonly enforceTradingWindows: boolean;
  private readonly audit: AuditLoggerLike;
  private readonly marketDataProvider?: (window: TradingWindow, traceId: string) => Promise<PaperMarketContext>;

  constructor(
    private readonly broker: SimulatedBroker = new ThsSimulatedBroker(),
    options: PaperTradingServiceOptions = {},
  ) {
    super();
    this.stateStore = options.stateStore ?? new MemoryPaperTradingStateStore();
    // 实盘计划默认按“最多持仓数”补足候选；若调用方明确传入 maxEntriesPerDay，
    // 仍保留该日新增上限（回测默认值仍由 trading-strategy.ts 单独控制）。
    const requestedStrategy = options.strategy ?? {};
    const hasExplicitEntryLimit = Object.prototype.hasOwnProperty.call(requestedStrategy, 'maxEntriesPerDay');
    const hasExplicitCandidateLimit = Object.prototype.hasOwnProperty.call(requestedStrategy, 'maxCandidates');
    const requestedMaxPositions = Math.max(1, Math.trunc(requestedStrategy.maxPositions ?? DEFAULT_T1_STRATEGY.maxPositions));
    this.strategy = createT1StrategyConfig({
      ...requestedStrategy,
      maxEntriesPerDay: hasExplicitEntryLimit
        ? requestedStrategy.maxEntriesPerDay ?? DEFAULT_T1_STRATEGY.maxEntriesPerDay
        : Math.max(DEFAULT_T1_STRATEGY.maxEntriesPerDay, requestedMaxPositions),
      maxCandidates: hasExplicitCandidateLimit
        ? requestedStrategy.maxCandidates ?? DEFAULT_T1_STRATEGY.maxCandidates
        : Math.max(DEFAULT_T1_STRATEGY.maxCandidates, requestedMaxPositions * 3),
    });
    this.now = options.now ?? (() => new Date());
    this.schedulerIntervalMs = Math.max(5_000, options.schedulerIntervalMs ?? 15_000);
    this.accountMonitorIntervalMs = Math.max(30_000, options.accountMonitorIntervalMs ?? 60_000);
    this.enforceTradingWindows = options.enforceTradingWindows ?? true;
    this.audit = options.audit ?? NOOP_AUDIT_LOGGER;
    this.marketDataProvider = options.marketDataProvider;
  }

  async getAutomation() {
    const state = await this.getState();
    const clock = shanghaiClock(this.now());
    return {
      ok: true,
      automation: { ...state.automation, next_window: this.nextWindowLabel(state, clock) },
      schedule: [
        { window: 'open', label: '开盘执行', time: '09:31', status: this.windowStatus(state, clock.date, 'open') },
        { window: 'near_close', label: '临收盘执行', time: '14:55', status: this.windowStatus(state, clock.date, 'near_close') },
        { window: 'close', label: '收盘决策', time: '15:05', status: this.windowStatus(state, clock.date, 'close') },
        { window: 'post_close', label: '盘后核对', time: '15:10', status: this.windowStatus(state, clock.date, 'post_close') },
      ],
    };
  }

  async getRuntimeState(): Promise<PaperTradingRuntimeState> {
    return structuredClone(await this.getState());
  }

  toggle(enabled: boolean, traceId: string = randomUUID()) {
    return this.exclusive(async () => {
      const state = await this.getState();
      state.automation = {
        ...state.automation,
        enabled,
        paused_today: false,
        last_error: undefined,
      };
      this.recordEvent(state, 'system', enabled ? 'automation_enabled' : 'automation_disabled', enabled ? '自动化已启用' : '自动化已关闭');
      await this.persist(state);
      await this.audit.info('paper_trading', enabled ? 'automation_enabled' : 'automation_disabled', {
        traceId,
        data: { enabled },
      });
      const payload = await this.getAutomation();
      this.broadcast('automation', payload);
      return payload;
    });
  }

  pause(paused: boolean, traceId: string = randomUUID()) {
    return this.exclusive(async () => {
      const state = await this.getState();
      state.automation = { ...state.automation, paused_today: paused };
      this.recordEvent(state, 'system', paused ? 'paused_today' : 'resumed_today', paused ? '今日自动交易已暂停' : '今日自动交易已恢复');
      await this.persist(state);
      await this.audit.info('paper_trading', paused ? 'automation_paused' : 'automation_resumed', {
        traceId,
        data: { paused_today: paused },
      });
      const payload = await this.getAutomation();
      this.broadcast('automation', payload);
      return payload;
    });
  }

  overview(
    analysis: AnalysisData,
    rankingDate: string,
    rankings: RankingRow[],
    calendar: string[] = [],
    traceId: string = randomUUID(),
    marketAverageChange?: number,
    limitUpRecords: Array<{ date: string; stock_code: string }> = [],
  ): Promise<PaperOverview> {
    if (this.overviewInFlight) return this.overviewInFlight;
    this.overviewInFlight = this.exclusive(() => this.buildOverview({ analysis, rankingDate, rankings, calendar, marketAverageChange, limitUpRecords }, traceId))
      .finally(() => { this.overviewInFlight = null; });
    return this.overviewInFlight;
  }

  async cachedOverview(
    analysis: AnalysisData,
    rankingDate: string,
    rankings: RankingRow[],
    calendar: string[] = [],
    traceId: string = randomUUID(),
    marketAverageChange?: number,
    limitUpRecords: Array<{ date: string; stock_code: string }> = [],
  ): Promise<PaperOverview> {
    const state = structuredClone(await this.getState());
    const observation = state.last_account_observation;
    const snapshot: SimulatedAccountSnapshot = {
      availableCash: observation?.available_cash ?? 0,
      totalAssets: observation?.total_assets ?? 0,
      positions: observation?.positions.map((position) => ({ ...position })) ?? [],
      orders: observation?.orders.map((order) => ({ ...order })) ?? [],
    };
    const connection: PaperOverview['connection'] = observation
      ? { status: 'cached', source: 'runtime-state', observed_at: observation.observed_at }
      : { status: 'unavailable', source: 'runtime-state' };
    if (observation) {
      const clock = shanghaiClock(this.now());
      this.initializeCapital(state, snapshot);
      this.reconcileState(state, snapshot, clock.date);
      await this.ensurePreviousClosePlan(state, snapshot, { analysis, rankingDate, rankings, calendar, marketAverageChange, limitUpRecords }, clock.date, traceId, true);
      await this.ensureSameDayCloseSignals(state, snapshot, { analysis, rankingDate, rankings, calendar, marketAverageChange, limitUpRecords }, clock, traceId, true);
    }
    await this.audit.info('paper_trading', 'cached_overview_built', {
      traceId,
      data: {
        ranking_date: rankingDate,
        observed_at: observation?.observed_at,
        positions: snapshot.positions.length,
        broker_orders: snapshot.orders.length,
        strategy_history: state.instructions.length,
      },
    });
    return this.composeOverview(state, snapshot, { analysis, rankingDate, rankings, calendar, marketAverageChange, limitUpRecords }, connection);
  }

  async execute(context?: PaperMarketContext, traceId?: string) {
    return this.runWindow('open', context, traceId, { trigger: 'immediate' });
  }

  async runWindowConfirmed(window: TradingWindow, context?: PaperMarketContext, traceId?: string) {
    return this.runWindow(window, context, traceId, { trigger: window === 'open' ? 'immediate' : 'manual' });
  }

  runWindow(
    window: TradingWindow,
    context?: PaperMarketContext,
    traceId: string = randomUUID(),
    options: RunWindowOptions = {},
  ): Promise<WindowRunResult> {
    const execution = this.exclusive<WindowRunResult>(async () => {
      const state = await this.getState();
      const clock = shanghaiClock(this.now());
      await this.audit.info('paper_trading', 'window_started', {
        traceId,
        data: { window, trigger: options.trigger ?? 'scheduled', trading_date: clock.date, strategy: this.strategy },
      });
      const allowManualOpenRetry = window === 'open' && options.trigger === 'immediate';
      if (this.isWindowCompleted(state, clock.date, window) && !allowManualOpenRetry) {
        await this.audit.warn('paper_trading', 'window_already_completed', {
          traceId,
          data: { window, trading_date: clock.date },
        });
        return {
          ok: true,
          window,
          trading_date: clock.date,
          status: 'already_completed',
          results: [],
          message: `${displayDate(clock.date)} ${window} 窗口已执行，未重复提交委托`,
        };
      }
      this.validateWindowTime(window, clock, options.trigger ?? 'scheduled');

      const market = context ?? await this.requireMarketContext(window, traceId);
      let snapshot = await this.readAndObserveAccount(state, traceId, `window:${window}:initial`);
      this.initializeCapital(state, snapshot);
      this.reconcileState(state, snapshot, clock.date);
      let results: PaperOrder[] = [];

      if (window === 'close') {
        results = await this.generateCloseSignals(state, snapshot, market, clock.date, traceId);
      } else if (window === 'open' || window === 'near_close') {
        await this.ensurePreviousClosePlan(state, snapshot, market, clock.date, traceId);
        ({ snapshot, results } = await this.executePlannedOrders(
          state,
          snapshot,
          market,
          clock.date,
          traceId,
          window,
          options.trigger === 'immediate',
        ));
        this.reconcileState(state, snapshot, clock.date);
      } else {
        this.expireMissedEntries(state, clock.date);
        this.reconcileState(state, snapshot, clock.date);
        this.recordEvent(state, 'post_close', 'reconciled', `盘后已核对 ${snapshot.positions.length} 只持仓和 ${snapshot.orders.length} 笔当日委托`);
      }

      this.markWindowCompleted(state, clock.date, window);
      state.automation = {
        ...state.automation,
        last_run: clock.timestamp,
        last_window: window,
        last_error: undefined,
      };
      await this.persist(state);
      const runLabel = options.trigger === 'immediate' ? '立即执行' : `${window} 窗口`;
      const message = `${displayDate(clock.date)} ${runLabel}完成，处理 ${results.length} 笔策略指令`;
      await this.audit.info('paper_trading', 'window_completed', {
        traceId,
        data: { window, trading_date: clock.date, results, message },
      });
      this.broadcast('window_done', { window, results, message });
      return { ok: true, window, trading_date: clock.date, status: 'completed', results, message };
    });
    return execution.catch(async (error) => {
      await this.audit.error('paper_trading', 'window_failed', {
        traceId,
        data: { window },
        error,
      });
      throw error;
    });
  }

  async cancel(
    confirmation: string,
    orderId: string,
    criteria?: { stock_code?: string; quantity?: number; side?: 'buy' | 'sell' },
    traceId: string = randomUUID(),
  ) {
    if (confirmation !== 'CANCEL') throw new Error('请输入 CANCEL 确认撤销同花顺模拟委托');
    return this.exclusive(async () => {
      const state = await this.getState();
      const snapshot = await this.readAndObserveAccount(state, traceId, 'cancel:lookup');
      const order = snapshot.orders.find((item) => item.id === orderId)
        ?? snapshot.orders.find((item) => (
          (!criteria?.stock_code || item.stock_code === criteria.stock_code)
          && (!criteria?.quantity || item.quantity === criteria.quantity)
          && (!criteria?.side || item.side === criteria.side)
        ));
      if (!order || !order.cancelable || order.quantity <= 0) throw new Error('该委托不存在、不可撤销或数量无法识别');
      const result = await this.broker.cancelOrder(order.side, order.stock_code, order.quantity, {
        traceId,
        stage: 'cancel',
        source: 'paper_trading',
      });
      for (const instruction of state.instructions) {
        if (!['submitting', 'submitted', 'uncertain'].includes(instruction.status)) continue;
        if (instruction.side === order.side && instruction.stock_code === order.stock_code) {
          instruction.status = 'cancelled';
          instruction.completed_at = shanghaiClock(this.now()).timestamp;
          instruction.broker_status = '已撤';
        }
      }
      this.recordEvent(state, 'system', 'order_cancelled', `已撤销 ${order.stock_code} ${order.quantity} 股模拟委托`, order.stock_code);
      await this.persist(state);
      await this.audit.info('paper_trading', 'cancel_completed', {
        traceId,
        data: { order, verified: result.verified },
      });
      const cancelled = { ...order, status: '已撤', cancelable: false };
      this.broadcast('order_cancelled', cancelled);
      return { ok: true, verified: result.verified, order: cancelled };
    });
  }

  monitorAccount(traceId: string = randomUUID(), source = 'manual_monitor') {
    return this.exclusive(async () => {
      const state = await this.getState();
      const clock = shanghaiClock(this.now());
      const snapshot = await this.readAndObserveAccount(state, traceId, source);
      this.initializeCapital(state, snapshot);
      this.reconcileState(state, snapshot, clock.date);
      await this.persist(state);
      await this.audit.info('account_monitor', 'monitor_completed', {
        traceId,
        data: {
          source,
          observed_at: clock.timestamp,
          available_cash: snapshot.availableCash,
          total_assets: snapshot.totalAssets,
          positions: snapshot.positions.length,
          orders: snapshot.orders.length,
        },
      });
      this.broadcast('account_monitored', { source, observed_at: clock.timestamp });
      return { ok: true, observed_at: clock.timestamp, account: snapshot };
    });
  }

  startScheduler() {
    if (this.scheduler) return;
    this.scheduler = setInterval(() => {
      guardDetachedPromise(this.tickScheduler(), 'paper_trading', 'scheduler_tick');
    }, this.schedulerIntervalMs);
    this.scheduler.unref?.();
    guardDetachedPromise(this.tickScheduler(), 'paper_trading', 'scheduler_tick');
  }

  stopScheduler() {
    if (!this.scheduler) return;
    clearInterval(this.scheduler);
    this.scheduler = null;
  }

  private async buildOverview(context: PaperMarketContext, traceId: string): Promise<PaperOverview> {
    const state = await this.getState();
    const snapshot = await this.readAndObserveAccount(state, traceId, 'overview');
    const clock = shanghaiClock(this.now());
    this.initializeCapital(state, snapshot);
    this.reconcileState(state, snapshot, clock.date);
    await this.ensurePreviousClosePlan(state, snapshot, context, clock.date, traceId);
    await this.ensureSameDayCloseSignals(state, snapshot, context, clock, traceId);
    await this.persist(state);
    await this.audit.info('paper_trading', 'overview_built', {
      traceId,
      data: {
        ranking_date: context.rankingDate,
        positions: snapshot.positions.length,
        broker_orders: snapshot.orders.length,
        active_instructions: state.instructions.filter(isActiveInstruction).length,
        strategy_history: state.instructions.length,
      },
    });

    return this.composeOverview(state, snapshot, context, {
      status: 'live',
      source: 'tonghuashun-gui',
      observed_at: state.last_account_observation?.observed_at,
    });
  }

  private composeOverview(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    connection: PaperOverview['connection'],
  ): PaperOverview {
    const clock = shanghaiClock(this.now());
    const timing = assessMarketTiming(context);
    const totalMarketValue = round(snapshot.positions.reduce((sum, item) => sum + item.market_value, 0), 2);
    const currentPositionPct = snapshot.totalAssets ? round(totalMarketValue / snapshot.totalAssets * 100, 1) : 0;
    const pnlAmount = round(snapshot.positions.reduce((sum, item) => sum + item.pnl_amount, 0), 2);
    const costBasis = snapshot.positions.reduce((sum, item) => sum + item.cost_price * item.shares, 0);
    const active = state.instructions.filter(isActiveInstruction);
    const trackedByCode = new Map(state.tracked_positions.map((position) => [position.stock_code, position]));
    const planOrders = active.map((instruction) => this.instructionToOrder(instruction));
    const history = [...state.instructions].reverse().map((instruction) => ({
      ...this.instructionToOrder(instruction, instruction.execution_price ?? instruction.signal_price),
      signal_date: instruction.signal_date,
      rank: instruction.rank,
      strategy_label: instruction.strategy_label,
      created_at: instruction.created_at,
      submitted_at: instruction.submitted_at,
      completed_at: instruction.completed_at,
      broker_status: instruction.broker_status,
    }));
    const skipped = state.instructions
      .filter((instruction) => instruction.status === 'skipped' || instruction.status === 'failed')
      .slice(-8)
      .map((instruction) => `${instruction.stock_code} ${instruction.reason}`);

    if (!active.length) skipped.unshift('暂无待执行信号；每个交易日收盘后会生成下一交易日的开盘或临收盘计划。');

    return {
      ok: true,
      connection,
      account: {
        total_assets: snapshot.totalAssets,
        available_cash: snapshot.availableCash,
        current_position_pct: currentPositionPct,
        positions: snapshot.positions.map((position) => {
          const tracked = trackedByCode.get(position.stock_code);
          return {
            ...position,
            entry_date: tracked?.entry_date,
            hold_days: tracked ? tradingDayDistance(tracked.entry_date, clock.date, context.calendar ?? []) : undefined,
            tracking_source: tracked?.source,
          };
        }),
        orders: snapshot.orders.map((order) => ({ ...order })),
        pnl_summary: { amount: pnlAmount, pct: costBasis ? round(pnlAmount / costBasis * 100, 2) : 0 },
      },
      plan: {
        target_position_pct: Math.min(100, this.strategy.maxPositions * this.strategy.positionSizePct),
        position_size_pct: this.strategy.positionSizePct,
        max_positions: this.strategy.maxPositions,
        max_entries_per_day: this.strategy.maxEntriesPerDay,
        max_hold_days: this.strategy.maxHoldDays,
        engine_version: PAPER_ENGINE_VERSION,
        methodology: '当日收盘生成信号；行情好时次日开盘买入、临近收盘卖出，行情不好时开盘卖出、临近收盘买入；策略判断全部由 Node.js 完成，AppleScript 只负责同花顺模拟账户查询与委托执行。',
        sentiment: timing.sentiment,
        ranking_date: context.rankingDate,
        market_reason: `当前行情${timing.weak ? '偏弱（卖出开盘、买入临收盘）' : '可交易（买入开盘、卖出临收盘）'}；${timing.reason}。最多持仓 ${this.strategy.maxPositions} 只、单票 ${this.strategy.positionSizePct}%、每日最多新增 ${this.strategy.maxEntriesPerDay} 只、止损 ${this.strategy.stopLossPct}%、止盈 +${this.strategy.takeProfitPct}%、最长持有 ${this.strategy.maxHoldDays} 个交易日。`,
        orders: planOrders,
        history,
        skipped,
      },
    };
  }

  /**
   * 收盘后（15:00+）如果排行截面日期就是当天且尚未生成信号，主动生成收盘计划。
   * 解决自动化关闭时 overview 不产生计划的问题。
   */
  private async ensureSameDayCloseSignals(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    clock: ReturnType<typeof shanghaiClock>,
    traceId: string,
    preview = false,
  ): Promise<PaperStrategyInstruction[]> {
    const signalDate = compactDate(context.rankingDate);
    if (signalDate !== clock.date) return [];
    if (clock.minute < 15 * 60) return [];
    if (state.last_signal_date === signalDate) return [];
    if (this.isWindowCompleted(state, clock.date, 'close')) return [];
    const generated = await this.generateCloseSignals(state, snapshot, context, clock.date, traceId);
    if (!preview && generated.length > 0) {
      this.markWindowCompleted(state, clock.date, 'close');
    }
    return state.instructions.filter((instruction) => instruction.signal_date === signalDate);
  }

  private async generateCloseSignals(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    tradingDate: string,
    traceId: string,
  ): Promise<PaperOrder[]> {
    const signalDate = compactDate(context.rankingDate);
    if (signalDate !== tradingDate) {
      throw new Error(`排行日期 ${context.rankingDate} 不是当前交易日 ${displayDate(tradingDate)}，拒绝生成收盘信号`);
    }

    this.expireMissedEntries(state, tradingDate);
    await this.audit.info('strategy', 'close_evaluation_started', {
      traceId,
      data: {
        trading_date: tradingDate,
        ranking_date: context.rankingDate,
        ranking_rows: context.rankings.length,
        positions: snapshot.positions,
        available_cash: snapshot.availableCash,
        reference_capital: state.reference_capital,
        config: this.strategy,
      },
    });
    const generated = await this.buildExitSignals(state, snapshot, context, signalDate, traceId, 'snapshot');

    const plannedSellCodes = new Set(generated.filter((item) => item.side === 'sell').map((item) => item.stock_code));
    generated.push(...await this.buildEntrySignals(state, snapshot, context, signalDate, traceId, plannedSellCodes));

    state.instructions.push(...generated);
    state.last_signal_date = signalDate;
    this.recordEvent(state, 'close', 'signals_generated', `收盘生成 ${generated.filter((item) => item.status === 'pending').length} 个待执行信号`);
    await this.audit.info('strategy', 'close_signals_generated', {
      traceId,
      data: {
        trading_date: tradingDate,
        instructions: generated,
      },
    });
    return generated.map((instruction) => this.instructionToOrder(instruction));
  }

  private async buildExitSignals(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    signalDate: string,
    traceId: string,
    priceSource: 'snapshot' | 'ranking',
    writeAudit = true,
  ): Promise<PaperStrategyInstruction[]> {
    const existingSignalSellCodes = new Set(
      state.instructions
        .filter((instruction) => instruction.side === 'sell' && instruction.signal_date === signalDate)
        .map((instruction) => instruction.stock_code),
    );
    const activeSellCodes = new Set(
      state.instructions
        .filter((instruction) => instruction.side === 'sell' && isActiveInstruction(instruction))
        .map((instruction) => instruction.stock_code),
    );
    const trackedByCode = new Map(state.tracked_positions.map((position) => [position.stock_code, position]));
    const rankingPriceByCode = new Map(
      context.rankings.map((row) => [row.stock_code, Number(row.latest_price ?? 0)]),
    );
    const executionWindow = executionWindowFor('sell', context);
    const generated: PaperStrategyInstruction[] = [];

    for (const position of snapshot.positions) {
      if (existingSignalSellCodes.has(position.stock_code) || activeSellCodes.has(position.stock_code)) continue;
      const tracked = trackedByCode.get(position.stock_code);
      const holdDays = tradingDayDistance(tracked?.entry_date ?? signalDate, signalDate, context.calendar ?? []);
      const rankingPrice = rankingPriceByCode.get(position.stock_code) ?? 0;
      const hasRankingPrice = Number.isFinite(rankingPrice) && rankingPrice > 0;
      const referencePrice = priceSource === 'snapshot' || !hasRankingPrice
        ? position.current_price
        : rankingPrice;
      const resolvedPriceSource = priceSource === 'ranking' && hasRankingPrice ? 'ranking' : 'snapshot';
      const entryPrice = tracked?.entry_price ?? position.cost_price;
      const hasReferencePrice = Number.isFinite(referencePrice) && referencePrice > 0;
      const strategyPnlPct = hasReferencePrice && entryPrice > 0
        ? (referencePrice - entryPrice) / entryPrice * 100
        : 0;
      const reason = hasReferencePrice
        ? exitSignalReason(strategyPnlPct, holdDays, this.strategy)
        : holdDays >= this.strategy.maxHoldDays
          ? `持仓满 ${holdDays} 日`
          : null;
      if (writeAudit) {
        await this.audit.debug('strategy', 'position_evaluated', {
          traceId,
          data: {
            stock_code: position.stock_code,
            stock_name: position.stock_name,
            signal_date: signalDate,
            price_source: resolvedPriceSource,
            entry_date: tracked?.entry_date,
            entry_price: entryPrice,
            reference_price: hasReferencePrice ? referencePrice : null,
            strategy_pnl_pct: hasReferencePrice ? round(strategyPnlPct, 4) : null,
            hold_days: holdDays,
            execution_window: executionWindow,
            exit_reason: reason,
            decision: reason ? 'sell' : 'hold',
          },
        });
      }
      if (!reason) continue;
      generated.push({
        id: randomUUID(),
        side: 'sell',
        stock_code: position.stock_code,
        stock_name: position.stock_name,
        signal_date: signalDate,
        signal_price: hasReferencePrice ? referencePrice : position.current_price,
        quantity: position.shares,
        reason: withExecutionTiming(reason, 'sell', executionWindow),
        execution_window: executionWindow,
        status: 'pending',
        created_at: shanghaiClock(this.now()).timestamp,
      });
    }
    return generated;
  }

  private async ensurePreviousClosePlan(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    tradingDate: string,
    traceId: string,
    preview = false,
  ): Promise<PaperStrategyInstruction[]> {
    const signalDate = compactDate(context.rankingDate);
    if (!/^\d{8}$/.test(signalDate) || signalDate >= tradingDate) return [];
    if (state.last_signal_date && state.last_signal_date > signalDate) return [];
    let migratedInstructions = 0;
    for (const instruction of state.instructions) {
      if (instruction.signal_date !== signalDate) continue;
      const desiredWindow = executionWindowFor(instruction.side, context);
      if (!instruction.execution_window || (instruction.status === 'pending' && instruction.execution_window !== desiredWindow)) {
        instruction.execution_window = desiredWindow;
        instruction.reason = withExecutionTiming(instruction.reason, instruction.side, desiredWindow);
        migratedInstructions += 1;
      }
    }

    const generated = await this.buildExitSignals(state, snapshot, context, signalDate, traceId, 'ranking', !preview);
    const plannedSellCodes = new Set(generated.map((instruction) => instruction.stock_code));
    generated.push(...await this.buildEntrySignals(
      state,
      snapshot,
      context,
      signalDate,
      traceId,
      plannedSellCodes,
      !preview,
    ));
    state.instructions.push(...generated);
    const migratedSignalDate = state.last_signal_date !== signalDate;
    state.last_signal_date = signalDate;
    if (!preview && (generated.length > 0 || migratedInstructions > 0 || migratedSignalDate)) {
      const pendingCount = generated.filter((instruction) => instruction.status === 'pending').length;
      if (generated.length > 0) {
        this.recordEvent(state, 'close', 'signals_backfilled', `补生成 ${displayDate(signalDate)} 收盘后的 ${pendingCount} 个交易计划`);
      } else if (migratedInstructions > 0) {
        this.recordEvent(state, 'close', 'signals_retimed', `按当前行情规则修复 ${migratedInstructions} 个交易计划的执行窗口`);
      }
      await this.audit.info('strategy', 'previous_close_plan_backfilled', {
        traceId,
        data: {
          signal_date: signalDate,
          trading_date: tradingDate,
          positions: snapshot.positions.map((position) => position.stock_code),
          max_positions: this.strategy.maxPositions,
          migrated_instructions: migratedInstructions,
          migrated_signal_date: migratedSignalDate,
          instructions: generated,
        },
      });
    }
    return generated;
  }

  private async buildEntrySignals(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    signalDate: string,
    traceId: string,
    plannedSellCodes: ReadonlySet<string>,
    writeAudit = true,
  ): Promise<PaperStrategyInstruction[]> {
    const buyExecutionWindow = executionWindowFor('buy', context);
    const windowOrder = (window: PlanExecutionWindow) => window === 'open' ? 0 : 1;
    const releasableSellCodes = new Set(
      state.instructions
        .filter((instruction) => (
          instruction.side === 'sell'
          && isActiveInstruction(instruction)
          && windowOrder(instruction.execution_window ?? 'open') <= windowOrder(buyExecutionWindow)
        ))
        .map((instruction) => instruction.stock_code),
    );
    const plannedSellWindow = executionWindowFor('sell', context);
    if (windowOrder(plannedSellWindow) <= windowOrder(buyExecutionWindow)) {
      for (const code of plannedSellCodes) releasableSellCodes.add(code);
    }
    const activeBuys = state.instructions.filter((instruction) => instruction.side === 'buy' && isActiveInstruction(instruction));
    const occupiedCodes = new Set(
      snapshot.positions
        .filter((position) => !releasableSellCodes.has(position.stock_code))
        .map((position) => position.stock_code),
    );
    for (const instruction of activeBuys) occupiedCodes.add(instruction.stock_code);

    const existingSignalBuys = state.instructions.filter(
      (instruction) => instruction.side === 'buy'
        && instruction.signal_date === signalDate
        && !['skipped', 'failed', 'cancelled'].includes(instruction.status),
    ).length;
    const availableSlots = Math.max(0, this.strategy.maxPositions - occupiedCodes.size);
    const planCount = Math.min(
      Math.max(0, this.strategy.maxEntriesPerDay - existingSignalBuys),
      availableSlots,
    );
    if (planCount <= 0) return [];

    const existingSignalBuyCodes = state.instructions
      .filter((instruction) => instruction.side === 'buy' && instruction.signal_date === signalDate)
      .map((instruction) => instruction.stock_code);
    const excludedCodes = new Set([
      ...snapshot.positions.map((position) => position.stock_code),
      ...activeBuys.map((instruction) => instruction.stock_code),
      ...existingSignalBuyCodes,
    ]);
    const candidates = rankEntryCandidates(
      context.rankings,
      excludedCodes,
      Math.max(this.strategy.maxCandidates, planCount),
    )
      .map((candidate, index) => ({
        ...candidate,
        rank: Number(candidate.rank) > 0 ? Number(candidate.rank) : index + 1,
      }));
    let estimatedCash = snapshot.availableCash;
    const referenceCapital = state.reference_capital ?? snapshot.totalAssets;
    const executionWindow = buyExecutionWindow;
    const generated: PaperStrategyInstruction[] = [];

    let plannedCount = 0;
    for (const candidate of candidates) {
      if (plannedCount >= planCount) break;
      const signalPrice = Number(candidate.latest_price ?? 0);
      const sizing = calculateEntrySize(estimatedCash, referenceCapital, signalPrice, this.strategy);
      const status = sizing ? 'pending' as const : 'skipped' as const;
      const reason = sizing
        ? withExecutionTiming(`信号日${signalDate} 排名#${candidate.rank} ${candidate.strategy_label}`, 'buy', executionWindow)
        : `信号日${signalDate} 排名#${candidate.rank} 可用资金不足一手`;
      generated.push({
        id: randomUUID(),
        side: 'buy',
        stock_code: candidate.stock_code,
        stock_name: candidate.stock_name,
        signal_date: signalDate,
        signal_price: signalPrice,
        quantity: sizing?.shares ?? 0,
        rank: candidate.rank,
        strategy_label: candidate.strategy_label,
        reason,
        execution_window: executionWindow,
        status,
        created_at: shanghaiClock(this.now()).timestamp,
      });
      if (writeAudit) {
        await this.audit.debug('strategy', 'entry_candidate_evaluated', {
          traceId,
          data: {
            stock_code: candidate.stock_code,
            stock_name: candidate.stock_name,
            rank: candidate.rank,
            total_score: candidate.total_score,
            strategy_label: candidate.strategy_label,
            signal_price: signalPrice,
            estimated_cash_before: estimatedCash,
            occupied_positions: occupiedCodes.size,
            max_positions: this.strategy.maxPositions,
            execution_window: executionWindow,
            sizing,
            decision: status,
            reason,
          },
        });
      }
      if (sizing) {
        estimatedCash = round(estimatedCash - sizing.totalCost, 2);
        plannedCount += 1;
      }
    }
    return generated;
  }

  private async executePlannedOrders(
    state: PaperTradingRuntimeState,
    initialSnapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    tradingDate: string,
    traceId: string,
    executionWindow: PlanExecutionWindow,
    immediate = false,
  ): Promise<{ snapshot: SimulatedAccountSnapshot; results: PaperOrder[] }> {
    let snapshot = initialSnapshot;
    const results: PaperOrder[] = [];
    const unresolved = state.instructions.filter((instruction) => instruction.status === 'submitting' || instruction.status === 'uncertain');
    if (unresolved.length > 0) {
      throw new Error(`存在 ${unresolved.length} 笔提交结果不确定的委托，请先根据同花顺委托和持仓人工核对，已停止本次交易窗口执行`);
    }
    const eligible = (instruction: PaperStrategyInstruction) => (
      instruction.status === 'pending'
      && instruction.signal_date < tradingDate
      && (immediate || (instruction.execution_window ?? 'open') === executionWindow)
    );
    const sells = state.instructions.filter((instruction) => instruction.side === 'sell' && eligible(instruction));
    const buys = state.instructions.filter((instruction) => instruction.side === 'buy' && eligible(instruction));
    await this.audit.info('strategy', 'window_execution_started', {
      traceId,
      data: {
        trading_date: tradingDate,
        ranking_date: context.rankingDate,
        execution_window: executionWindow,
        immediate,
        pending_sells: sells,
        pending_buys: buys,
        account: initialSnapshot,
      },
    });

    for (const instruction of sells) {
      const position = snapshot.positions.find((item) => item.stock_code === instruction.stock_code);
      if (!position) {
        instruction.status = 'filled';
        instruction.completed_at = shanghaiClock(this.now()).timestamp;
        await this.audit.info('strategy', 'sell_already_absent', { traceId, data: { instruction } });
        continue;
      }
      const quantity = Math.min(instruction.quantity || position.shares, position.available_shares);
      if (quantity <= 0) {
        this.recordEvent(state, executionWindow, 'sell_deferred', `${instruction.stock_code} 当前无可卖股份，退出信号保留到下一交易窗口`, instruction.stock_code);
        await this.audit.warn('strategy', 'sell_deferred', {
          traceId,
          data: { instruction, position, reason: 'available_shares_zero' },
        });
        continue;
      }
      instruction.quantity = quantity;
      const order = this.instructionToOrder(instruction, position.current_price);
      await this.submitBrokerOrder(state, instruction, order, traceId);
      results.push({ ...this.instructionToOrder(instruction, instruction.execution_price), status: '已提交并回查' });
      this.recordEvent(state, executionWindow, 'sell_submitted', `卖出 ${instruction.stock_code} ${quantity} 股`, instruction.stock_code);
    }

    if (sells.some((instruction) => instruction.status === 'submitted')) {
      snapshot = await this.readAndObserveAccount(state, traceId, `${executionWindow}:after_sells`);
      this.reconcileState(state, snapshot, tradingDate);
    }

    let availableCash = snapshot.availableCash;
    const referenceCapital = state.reference_capital ?? snapshot.totalAssets;
    const occupiedCodes = new Set(snapshot.positions.map((position) => position.stock_code));
    const pendingBuys = state.instructions
      .filter((instruction) => instruction.side === 'buy' && eligible(instruction))
      .slice(0, this.strategy.maxEntriesPerDay);
    const executionLimitUpCodes = exactLimitUpCodes(context, tradingDate);

    for (const instruction of pendingBuys) {
      if (occupiedCodes.has(instruction.stock_code)) {
        instruction.status = 'filled';
        instruction.completed_at = shanghaiClock(this.now()).timestamp;
        await this.audit.info('strategy', 'buy_already_held', { traceId, data: { instruction } });
        continue;
      }
      if (occupiedCodes.size >= this.strategy.maxPositions) {
        instruction.status = 'skipped';
        instruction.completed_at = shanghaiClock(this.now()).timestamp;
        instruction.reason = `${instruction.reason}；已达到最多 ${this.strategy.maxPositions} 只持仓`;
        await this.audit.warn('strategy', 'buy_skipped_position_limit', {
          traceId,
          data: { instruction, occupied_positions: occupiedCodes.size, max_positions: this.strategy.maxPositions },
        });
        continue;
      }
      if (executionLimitUpCodes.has(instruction.stock_code)) {
        instruction.status = 'skipped';
        instruction.completed_at = shanghaiClock(this.now()).timestamp;
        instruction.reason = `${instruction.reason}；block_top 确认执行日涨停，无法买入`;
        this.recordEvent(state, executionWindow, 'buy_skipped_limit_up', `${instruction.stock_code} 已在同花顺 block_top 涨停名单，跳过买入`, instruction.stock_code);
        await this.audit.warn('strategy', 'buy_skipped_limit_up', {
          traceId,
          data: { instruction, trading_date: tradingDate, source: 'ths-block-top' },
        });
        continue;
      }
      const quote = await this.broker.quote(instruction.stock_code, {
        traceId,
        stage: `${executionWindow}:quote`,
        source: 'paper_trading',
      });
      const sizing = calculateEntrySize(availableCash, referenceCapital, quote, this.strategy);
      if (!sizing) {
        instruction.status = 'skipped';
        instruction.completed_at = shanghaiClock(this.now()).timestamp;
        instruction.reason = `${instruction.reason}；执行时资金不足一手`;
        await this.audit.warn('strategy', 'buy_skipped_insufficient_cash', {
          traceId,
          data: { instruction, quote, available_cash: availableCash, reference_capital: referenceCapital },
        });
        continue;
      }
      instruction.quantity = sizing.shares;
      const order = this.instructionToOrder(instruction, quote);
      await this.submitBrokerOrder(state, instruction, order, traceId);
      results.push({ ...this.instructionToOrder(instruction, instruction.execution_price), status: '已提交并回查' });
      availableCash = round(availableCash - sizing.totalCost, 2);
      occupiedCodes.add(instruction.stock_code);
      this.recordEvent(state, executionWindow, 'buy_submitted', `买入 ${instruction.stock_code} ${sizing.shares} 股`, instruction.stock_code);
    }

    if (results.length > 0) snapshot = await this.readAndObserveAccount(state, traceId, `${executionWindow}:after_orders`);
    this.expireMissedEntries(state, tradingDate, immediate ? undefined : executionWindow);
    await this.audit.info('strategy', 'window_execution_completed', {
      traceId,
      data: { trading_date: tradingDate, execution_window: executionWindow, immediate, results, final_account: snapshot },
    });
    return { snapshot, results };
  }

  private reconcileState(state: PaperTradingRuntimeState, snapshot: SimulatedAccountSnapshot, tradingDate: string) {
    const actualByCode = new Map(snapshot.positions.map((position) => [position.stock_code, position]));
    const timestamp = shanghaiClock(this.now()).timestamp;

    for (const instruction of state.instructions) {
      if (!['submitting', 'submitted', 'uncertain'].includes(instruction.status)) continue;
      const actual = actualByCode.get(instruction.stock_code);
      const brokerOrder = snapshot.orders.find((order) => order.side === instruction.side && order.stock_code === instruction.stock_code);
      if (instruction.side === 'buy' && actual) {
        instruction.status = 'filled';
        instruction.completed_at = timestamp;
        instruction.broker_status = '持仓已核对';
      } else if (instruction.side === 'sell' && !actual) {
        instruction.status = 'filled';
        instruction.completed_at = timestamp;
        instruction.broker_status = '持仓已清零';
      } else if (brokerOrder?.cancelable) {
        instruction.status = 'submitted';
        instruction.broker_status = brokerOrder.status || '委托列表已核对';
      } else if (brokerOrder && ['已撤', '已取消'].some((marker) => brokerOrder.status.includes(marker))) {
        instruction.status = 'cancelled';
        instruction.completed_at = timestamp;
        instruction.broker_status = brokerOrder.status;
      } else if (brokerOrder && ['废单', '拒绝'].some((marker) => brokerOrder.status.includes(marker))) {
        instruction.status = 'failed';
        instruction.completed_at = timestamp;
        instruction.broker_status = brokerOrder.status;
      }
    }

    const previous = new Map(state.tracked_positions.map((position) => [position.stock_code, position]));
    const tracked: PaperTrackedPosition[] = [];
    for (const actual of snapshot.positions) {
      const existing = previous.get(actual.stock_code);
      const strategyBuy = [...state.instructions].reverse().find((instruction) => (
        instruction.side === 'buy'
        && instruction.stock_code === actual.stock_code
        && (instruction.status === 'submitted' || instruction.status === 'filled')
      ));
      const submittedDate = compactDate(strategyBuy?.submitted_at ?? tradingDate);
      tracked.push({
        stock_code: actual.stock_code,
        stock_name: actual.stock_name,
        entry_date: existing?.entry_date ?? submittedDate,
        entry_price: existing?.entry_price
          ?? strategyBuy?.execution_price
          ?? (actual.cost_price > 0 ? actual.cost_price : actual.current_price),
        shares: actual.shares,
        source: existing?.source ?? (strategyBuy ? 'strategy' : 'reconciled'),
        signal_date: existing?.signal_date ?? strategyBuy?.signal_date,
      });
    }
    state.tracked_positions = tracked;
  }

  private expireMissedEntries(
    state: PaperTradingRuntimeState,
    tradingDate: string,
    executionWindow?: PlanExecutionWindow,
  ) {
    for (const instruction of state.instructions) {
      if (instruction.side !== 'buy' || instruction.status !== 'pending') continue;
      if (instruction.signal_date >= tradingDate) continue;
      if (executionWindow && (instruction.execution_window ?? 'open') !== executionWindow) continue;
      instruction.status = 'skipped';
      instruction.completed_at = shanghaiClock(this.now()).timestamp;
      instruction.reason = `${instruction.reason}；已错过${executionWindowLabel(instruction.execution_window ?? 'open')}窗口`;
    }
  }

  private initializeCapital(state: PaperTradingRuntimeState, snapshot: SimulatedAccountSnapshot) {
    if (state.reference_capital == null || state.reference_capital <= 0) {
      state.reference_capital = snapshot.totalAssets;
      this.recordEvent(state, 'system', 'capital_initialized', `策略基准资金初始化为 ${snapshot.totalAssets.toFixed(2)}`);
    }
  }

  private async readAndObserveAccount(
    state: PaperTradingRuntimeState,
    traceId: string,
    stage: string,
  ): Promise<SimulatedAccountSnapshot> {
    const context: BrokerCallContext = { traceId, stage, source: 'paper_trading' };
    const snapshot = await this.broker.snapshot(context);
    await this.observeAccountChanges(state, snapshot, traceId, stage);
    return snapshot;
  }

  private async observeAccountChanges(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    traceId: string,
    source: string,
  ) {
    const clock = shanghaiClock(this.now());
    const previous = state.last_account_observation;
    const current: PaperAccountObservation = {
      observed_at: clock.timestamp,
      available_cash: snapshot.availableCash,
      total_assets: snapshot.totalAssets,
      positions: snapshot.positions.map((position) => ({ ...position })),
      orders: snapshot.orders.map((order) => ({ ...order })),
    };

    if (!previous) {
      await this.audit.info('account_monitor', 'initial_snapshot', {
        traceId,
        data: { source, snapshot: current },
      });
      state.last_account_observation = current;
      return;
    }

    const changes: Array<Record<string, unknown>> = [];
    if (previous.available_cash !== current.available_cash) {
      changes.push({ type: 'available_cash_changed', before: previous.available_cash, after: current.available_cash });
    }
    if (previous.total_assets !== current.total_assets) {
      changes.push({ type: 'total_assets_changed', before: previous.total_assets, after: current.total_assets });
    }

    const previousPositions = new Map(previous.positions.map((position) => [position.stock_code, position]));
    const currentPositions = new Map(current.positions.map((position) => [position.stock_code, position]));
    for (const code of new Set([...previousPositions.keys(), ...currentPositions.keys()])) {
      const before = previousPositions.get(code);
      const after = currentPositions.get(code);
      if (!before && after) {
        changes.push({ type: 'position_added', stock_code: code, after });
        continue;
      }
      if (before && !after) {
        changes.push({ type: 'position_removed', stock_code: code, before });
        continue;
      }
      if (!before || !after) continue;
      const fieldChanges: Record<string, { before: number | string; after: number | string }> = {};
      for (const field of ['stock_name', 'shares', 'available_shares', 'cost_price', 'current_price', 'market_value', 'pnl_amount', 'pnl_pct'] as const) {
        if (before[field] !== after[field]) fieldChanges[field] = { before: before[field], after: after[field] };
      }
      if (Object.keys(fieldChanges).length > 0) changes.push({ type: 'position_changed', stock_code: code, fields: fieldChanges });
    }

    const orderKey = (order: PaperOrder) => `${order.side}:${order.stock_code}:${order.quantity}:${order.price}`;
    const previousOrders = new Map(previous.orders.map((order) => [orderKey(order), order]));
    const currentOrders = new Map(current.orders.map((order) => [orderKey(order), order]));
    for (const key of new Set([...previousOrders.keys(), ...currentOrders.keys()])) {
      const before = previousOrders.get(key);
      const after = currentOrders.get(key);
      if (!before && after) changes.push({ type: 'order_added', key, after });
      else if (before && !after) changes.push({ type: 'order_removed', key, before });
      else if (before && after && (before.status !== after.status || before.cancelable !== after.cancelable)) {
        changes.push({ type: 'order_status_changed', key, before, after });
      }
    }

    state.last_account_observation = current;
    if (changes.length > 0) {
      await this.audit.info('account_monitor', 'account_changed', {
        traceId,
        data: { source, previous_observed_at: previous.observed_at, observed_at: current.observed_at, changes, snapshot: current },
      });
    } else {
      await this.audit.debug('account_monitor', 'account_unchanged', {
        traceId,
        data: {
          source,
          observed_at: current.observed_at,
          available_cash: current.available_cash,
          total_assets: current.total_assets,
          positions: current.positions.length,
          orders: current.orders.length,
        },
      });
    }
  }

  private async submitBrokerOrder(
    state: PaperTradingRuntimeState,
    instruction: PaperStrategyInstruction,
    order: PaperOrder,
    traceId: string,
  ): Promise<BrokerActionResult> {
    instruction.status = 'submitting';
    instruction.submitted_at = shanghaiClock(this.now()).timestamp;
    instruction.broker_status = '正在调用 AppleScript 提交并回查';
    await this.persist(state);
    await this.audit.info('order', 'submission_started', {
      traceId,
      data: { instruction, order },
    });
    try {
      const action = await this.broker.placeOrder(order, {
        traceId,
        stage: `${instruction.execution_window ?? 'open'}:submit_order`,
        source: 'paper_trading',
      });
      instruction.status = 'submitted';
      instruction.broker_status = '已提交并回查';
      instruction.execution_price = action.executionPrice ?? order.price;
      instruction.quantity = action.executionQuantity ?? order.quantity;
      await this.persist(state);
      await this.audit.info('order', 'submission_verified', {
        traceId,
        data: { instruction, order, broker_result: action },
      });
      return action;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      instruction.status = 'uncertain';
      instruction.broker_status = `提交结果不确定：${message}`;
      state.automation = { ...state.automation, last_error: message };
      this.recordEvent(state, instruction.execution_window ?? 'open', 'order_submission_uncertain', `${instruction.stock_code} ${message}`, instruction.stock_code);
      await this.persist(state);
      await this.audit.error('order', 'submission_uncertain', {
        traceId,
        data: { instruction, order },
        error,
      });
      throw error;
    }
  }

  private instructionToOrder(instruction: PaperStrategyInstruction, price = instruction.signal_price): PaperOrder {
    const executionWindow = instruction.execution_window ?? 'open';
    const timing = executionWindow === 'open' ? '下一交易日开盘' : '下一交易日临近收盘';
    return {
      id: instruction.id,
      side: instruction.side,
      stock_code: instruction.stock_code,
      stock_name: instruction.stock_name,
      quantity: instruction.quantity,
      price: round(price, 4),
      amount: round(price * instruction.quantity, 2),
      status: instructionStatusLabel(instruction),
      reason: instruction.status === 'uncertain' && instruction.broker_status
        ? `${instruction.reason}；${instruction.broker_status}`
        : instruction.reason,
      window: `${timing}·${instruction.side === 'sell' ? '卖出' : '买入'}`,
      execution_window: executionWindow,
      signal_date: instruction.signal_date,
      rank: instruction.rank,
      strategy_label: instruction.strategy_label,
      cancelable: instruction.status === 'submitted',
    };
  }

  private async tickScheduler() {
    if (this.schedulerTickInFlight) return this.schedulerTickInFlight;
    this.schedulerTickInFlight = (async () => {
      const state = await this.getState();
      const clock = shanghaiClock(this.now());
      if (!state.automation.enabled || state.automation.paused_today || clock.weekday === 0 || clock.weekday === 6) return;
      const nowMs = this.now().getTime();

      let due: TradingWindow | null = null;
      if (clock.minute >= 9 * 60 + 31 && clock.minute < 10 * 60 && !this.isWindowCompleted(state, clock.date, 'open')) {
        due = 'open';
      } else if (clock.minute >= 14 * 60 + 55 && clock.minute < 15 * 60 && !this.isWindowCompleted(state, clock.date, 'near_close')) {
        due = 'near_close';
      } else if (clock.minute >= 15 * 60 + 5 && !this.isWindowCompleted(state, clock.date, 'close')) {
        due = 'close';
      } else if (clock.minute >= 15 * 60 + 10 && !this.isWindowCompleted(state, clock.date, 'post_close')) {
        due = 'post_close';
      }
      if (due) {
        if (nowMs < this.schedulerRetryAfter) return;
        try {
          await this.runWindow(due);
          this.schedulerRetryAfter = 0;
        } catch (error) {
          this.schedulerRetryAfter = this.now().getTime() + 5 * 60_000;
          await this.exclusive(async () => {
            const current = await this.getState();
            const message = error instanceof Error ? error.message : String(error);
            current.automation = { ...current.automation, last_error: message };
            this.recordEvent(current, due ?? 'system', 'window_failed', message);
            await this.persist(current);
            this.broadcast('window_failed', { window: due, error: message });
          });
        }
        return;
      }

      const monitoringHours = clock.minute >= 9 * 60 + 25 && clock.minute <= 15 * 60 + 20;
      if (!monitoringHours || nowMs < this.monitorRetryAfter || nowMs - this.lastMonitorAt < this.accountMonitorIntervalMs) return;
      this.lastMonitorAt = nowMs;
      try {
        await this.monitorAccount(randomUUID(), 'scheduled_monitor');
        this.monitorRetryAfter = 0;
      } catch (error) {
        this.monitorRetryAfter = nowMs + 5 * 60_000;
        await this.audit.error('account_monitor', 'scheduled_monitor_failed', { error });
      }
    })().finally(() => { this.schedulerTickInFlight = null; });
    return this.schedulerTickInFlight;
  }

  private requireMarketContext(window: TradingWindow, traceId: string): Promise<PaperMarketContext> {
    if (!this.marketDataProvider) throw new Error('Node 交易核心未配置市场数据提供器');
    return this.marketDataProvider(window, traceId);
  }

  private getState(): Promise<PaperTradingRuntimeState> {
    if (!this.statePromise) {
      this.statePromise = this.stateStore.load().then((stored) => {
        const timestamp = shanghaiClock(this.now()).timestamp;
        if (!stored || stored.schema_version !== 1) return defaultState(timestamp);
        return {
          ...defaultState(timestamp),
          ...stored,
          engine_version: PAPER_ENGINE_VERSION,
          automation: { ...defaultAutomation(), ...stored.automation },
          completed_windows: stored.completed_windows ?? {},
          instructions: (stored.instructions ?? []).map((instruction) => instruction.status === 'submitting'
            ? { ...instruction, status: 'uncertain', broker_status: '服务重启时委托仍处于提交中，请根据同花顺委托和持仓人工核对' }
            : instruction),
          tracked_positions: stored.tracked_positions ?? [],
          events: stored.events ?? [],
        };
      });
    }
    return this.statePromise;
  }

  private async persist(state: PaperTradingRuntimeState) {
    const clock = shanghaiClock(this.now());
    state.updated_at = clock.timestamp;
    state.engine_version = PAPER_ENGINE_VERSION;
    state.automation.next_window = this.nextWindowLabel(state, clock);
    state.events = state.events.slice(-200);
    // 策略计划是交易审计账本，已成交、跳过、失败和已撤记录都永久保留。
    state.instructions = [...state.instructions].sort((left, right) => left.created_at.localeCompare(right.created_at));
    const completedDates = Object.keys(state.completed_windows).sort().slice(-30);
    state.completed_windows = Object.fromEntries(completedDates.map((date) => [date, state.completed_windows[date]]));
    await this.stateStore.save(state);
  }

  private recordEvent(
    state: PaperTradingRuntimeState,
    window: TradingWindow | 'system',
    type: string,
    message: string,
    stockCode?: string,
  ) {
    const clock = shanghaiClock(this.now());
    const event: PaperTradingEvent = {
      id: randomUUID(),
      timestamp: clock.timestamp,
      trading_date: clock.date,
      window,
      type,
      message,
      stock_code: stockCode,
    };
    state.events.push(event);
  }

  private isWindowCompleted(state: PaperTradingRuntimeState, date: string, window: TradingWindow): boolean {
    return state.completed_windows[date]?.includes(window) ?? false;
  }

  private markWindowCompleted(state: PaperTradingRuntimeState, date: string, window: TradingWindow) {
    const completed = new Set(state.completed_windows[date] ?? []);
    completed.add(window);
    state.completed_windows[date] = [...completed];
  }

  private windowStatus(state: PaperTradingRuntimeState, date: string, window: TradingWindow) {
    if (this.isWindowCompleted(state, date, window)) return 'completed';
    if (!state.automation.enabled) return 'disabled';
    if (state.automation.paused_today) return 'paused';
    return 'waiting';
  }

  private nextWindowLabel(state: PaperTradingRuntimeState, clock: ReturnType<typeof shanghaiClock>): string {
    if (!state.automation.enabled) return '自动化已关闭';
    if (state.automation.paused_today) return '今日已暂停';
    if (clock.minute < 9 * 60 + 31 && !this.isWindowCompleted(state, clock.date, 'open')) return '下一窗口：09:31 开盘执行';
    if (clock.minute < 14 * 60 + 55 && !this.isWindowCompleted(state, clock.date, 'near_close')) return '下一窗口：14:55 临收盘执行';
    if (clock.minute < 15 * 60 + 5 && !this.isWindowCompleted(state, clock.date, 'close')) return '下一窗口：15:05 收盘决策';
    if (clock.minute < 15 * 60 + 10 && !this.isWindowCompleted(state, clock.date, 'post_close')) return '下一窗口：15:10 盘后核对';
    return '下一窗口：下一交易日 09:31 开盘执行';
  }

  private validateWindowTime(
    window: TradingWindow,
    clock: ReturnType<typeof shanghaiClock>,
    trigger: 'scheduled' | 'manual' | 'immediate',
  ) {
    if (!this.enforceTradingWindows) return;
    if (clock.weekday === 0 || clock.weekday === 6) throw new Error('当前不是交易日，拒绝运行交易窗口');
    if (window === 'open' && trigger === 'immediate' && (clock.minute < 9 * 60 + 25 || clock.minute >= 15 * 60)) {
      throw new Error('立即执行仅允许在交易日 09:25-15:00 运行');
    }
    if (window === 'open' && (trigger === 'scheduled' || trigger === 'manual') && (clock.minute < 9 * 60 + 25 || clock.minute >= 10 * 60)) {
      throw new Error('开盘执行窗口仅允许在交易日 09:25-10:00 运行');
    }
    if (window === 'near_close' && (clock.minute < 14 * 60 + 50 || clock.minute >= 15 * 60)) {
      throw new Error('临收盘执行窗口仅允许在交易日 14:50-15:00 运行');
    }
    if (window === 'close' && clock.minute < 15 * 60) {
      throw new Error('收盘决策窗口仅允许在交易日 15:00 后运行');
    }
    if (window === 'post_close' && clock.minute < 15 * 60 + 5) {
      throw new Error('盘后核对窗口仅允许在交易日 15:05 后运行');
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private broadcast(type: string, payload: unknown) {
    this.emit('update', { type, payload, timestamp: shanghaiClock(this.now()).timestamp });
  }
}
