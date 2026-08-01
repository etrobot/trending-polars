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
  serializeStrategyConfig,
  strategyFromBacktestConfig,
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
import {
  assessMarketTiming,
  buildTradingSession,
  compactDate,
  defaultAutomation,
  defaultState,
  displayDate,
  exactLimitUpCodes,
  executionWindowFor,
  executionWindowLabel,
  isActiveInstruction,
  instructionStatusLabel,
  isAmbiguousSubmissionFailure,
  normalizeInstructionOnLoad,
  summarizeSubmissionError,
  isAccountSyncOnlyPeriod,
  isTradingDay,
  isWeakMarket,
  LATE_WINDOW_END_MINUTE,
  MARKET_CLOSE_MINUTE,
  nextTradingDateAfter,
  type MarketTimingAssessment,
  MemoryPaperTradingStateStore,
  NEAR_CLOSE_WINDOW_START_MINUTE,
  type PaperMarketContext,
  type PaperTradingServiceOptions,
  type PaperTradingStateStore,
  PAPER_ENGINE_VERSION,
  type RunWindowOptions,
  TRADING_CALENDAR_REFRESH_INTERVAL_MS,
  TRADING_CALENDAR_STALE_REFRESH_INTERVAL_MS,
  type ThsReadinessProvider,
  thsReadyTimeoutMs,
  thsWarmupSlot,
  type WindowRunResult,
  shanghaiClock,
  windowRetryDelayMs,
  withExecutionTiming,
} from './paper-trading/helpers.js';

export { PAPER_ENGINE_VERSION } from './paper-trading/helpers.js';

export type { PaperMarketContext, PaperTradingServiceOptions, PaperTradingStateStore };

export class PaperTradingService extends EventEmitter {
  private overviewInFlight: Promise<PaperOverview> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private statePromise: Promise<PaperTradingRuntimeState> | null = null;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private schedulerTickInFlight: Promise<void> | null = null;
  /** 按 `${交易日}:${窗口}` 记录连续失败次数与下次可重试时刻，窗口之间互不拖累。 */
  private readonly windowRetry = new Map<string, { failures: number; retryAfter: number }>();
  private monitorRetryAfter = 0;
  private lastMonitorAt = 0;
  private cachedTradingCalendar: string[] = [];
  private lastCalendarRefreshAt = 0;
  private calendarRefreshInFlight: Promise<string[]> | null = null;
  private calendarRefreshedThisTick = false;
  private readonly stateStore: PaperTradingStateStore;
  private strategy: T1StrategyConfig;
  private strategyHydratedFromState = false;
  private readonly now: () => Date;
  private readonly schedulerIntervalMs: number;
  private readonly accountMonitorIntervalMs: number;
  private readonly enforceTradingWindows: boolean;
  private readonly audit: AuditLoggerLike;
  private readonly calendarRefresher?: () => Promise<string[]>;
  private readonly calendarRefreshIntervalMs: number;
  private readonly thsReadiness?: ThsReadinessProvider;
  /** 当天已跑过的同花顺预热槽位，`${日期}:${槽位}`。仅进程内，重启后补跑一次无害。 */
  private readonly warmedUpSlots = new Set<string>();
  private readonly marketDataProvider?: (window: TradingWindow, traceId: string) => Promise<PaperMarketContext>;

  constructor(
    private readonly broker: SimulatedBroker = new ThsSimulatedBroker(),
    options: PaperTradingServiceOptions = {},
  ) {
    super();
    this.stateStore = options.stateStore ?? new MemoryPaperTradingStateStore();
    // 实盘计划默认按"最多持仓数"补足候选；若调用方明确传入 maxEntriesPerDay，
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
    this.calendarRefresher = options.calendarRefresher;
    this.calendarRefreshIntervalMs = Math.max(60_000, options.calendarRefreshIntervalMs ?? TRADING_CALENDAR_REFRESH_INTERVAL_MS);
    this.marketDataProvider = options.marketDataProvider;
    this.thsReadiness = options.thsReadiness;
  }

  async getAutomation() {
    const state = await this.getState();
    const clock = shanghaiClock(this.now());
    return {
      ok: true,
      automation: { ...state.automation, next_window: this.nextWindowLabel(state, clock) },
      schedule: [
        { window: 'open', label: '开盘执行', time: '09:31', status: this.windowStatus(state, clock.date, 'open') },
        { window: 'near_close', label: '临收盘执行', time: '14:57', status: this.windowStatus(state, clock.date, 'near_close') },
        { window: 'close', label: '收盘决策', time: '15:05', status: this.windowStatus(state, clock.date, 'close') },
        { window: 'post_close', label: '盘后核对', time: '15:10', status: this.windowStatus(state, clock.date, 'post_close') },
      ],
    };
  }

  async getRuntimeState(): Promise<PaperTradingRuntimeState> {
    return structuredClone(await this.getState());
  }

  applyBacktestStrategy(
    runId: string,
    config: Record<string, number | string | null | undefined>,
    traceId: string = randomUUID(),
  ) {
    return this.exclusive(async () => {
      const overrides = strategyFromBacktestConfig(config);
      if (!Object.keys(overrides).length) {
        throw new Error('回测记录中没有可应用的策略参数');
      }
      const maxPositions = Math.max(
        1,
        Math.trunc(overrides.maxPositions ?? this.strategy.maxPositions),
      );
      this.strategy = createT1StrategyConfig({
        ...this.strategy,
        ...overrides,
        maxEntriesPerDay: overrides.maxEntriesPerDay
          ?? Math.max(DEFAULT_T1_STRATEGY.maxEntriesPerDay, maxPositions),
        maxCandidates: Math.max(this.strategy.maxCandidates, maxPositions * 3),
      });
      const state = await this.getState();
      state.strategy_config = serializeStrategyConfig(this.strategy);
      state.applied_backtest_run_id = runId;
      this.recordEvent(state, 'system', 'strategy_applied', `已加载回测参数 ${runId}`);
      await this.persist(state);
      const activeStrategy = this.resolveActiveStrategy(state);
      const plan = this.planStrategyFields(activeStrategy);
      console.log('[paper] applied backtest strategy', {
        run_id: runId,
        strategy: state.strategy_config,
        plan,
      });
      await this.audit.info('paper_trading', 'strategy_applied_from_backtest', {
        traceId,
        data: { run_id: runId, strategy: state.strategy_config, plan },
      });
      const payload = {
        ok: true,
        run_id: runId,
        strategy: state.strategy_config,
        plan,
      };
      this.broadcast('status', payload);
      return payload;
    });
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
      if (enabled) {
        guardDetachedPromise(this.refreshTradingCalendar(true), 'paper_trading', 'calendar_refresh_on_enable');
      }
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

  isAccountSyncOnlyNow(calendar: readonly string[] = []): boolean {
    return isAccountSyncOnlyPeriod(shanghaiClock(this.now()), calendar);
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
    const clock = shanghaiClock(this.now());
    this.expirePendingPlans(state, clock, calendar);
    const accountOnly = isAccountSyncOnlyPeriod(clock, calendar);
    if (observation && !accountOnly) {
      this.initializeCapital(state, snapshot);
      this.reconcileUncertainInstructions(state, snapshot, traceId);
      this.reconcileState(state, snapshot, clock.date);
      await this.ensurePreviousClosePlan(state, snapshot, { analysis, rankingDate, rankings, calendar, marketAverageChange, limitUpRecords }, clock.date, traceId, true);
      await this.ensureSameDayCloseSignals(state, snapshot, { analysis, rankingDate, rankings, calendar, marketAverageChange, limitUpRecords }, clock, traceId, true);
    } else if (observation) {
      this.initializeCapital(state, snapshot);
      this.reconcileState(state, snapshot, clock.date);
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
      // 过期是既成事实，先落盘：后面读账户/下单失败时整个块会抛出，
      // 不落盘的话内存标了 expired 而磁盘还是 pending。
      if (this.expirePendingPlans(state, clock, market.calendar ?? []) > 0) {
        await this.persist(state);
      }
      // 同花顺就绪兜底：必须在任何券商调用之前，所以不存在"下单失败后重拉重试
      // 导致重复报单"的风险。已就绪时只花一次探测。
      await this.ensureThsReady(state, `window:${window}`, thsReadyTimeoutMs(window), traceId);
      let snapshot = await this.readAndObserveAccount(state, traceId, `window:${window}:initial`);
      this.initializeCapital(state, snapshot);
      this.reconcileUncertainInstructions(state, snapshot, traceId);
      this.reconcileState(state, snapshot, clock.date);
      let results: PaperOrder[] = [];
      let pendingRemaining = 0;

      if (window === 'close') {
        results = await this.generateCloseSignals(state, snapshot, market, clock.date, traceId);
      } else if (window === 'open' || window === 'near_close') {
        await this.ensurePreviousClosePlan(state, snapshot, market, clock.date, traceId);
        ({ snapshot, results, pendingRemaining } = await this.executePlannedOrders(
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
        this.reconcileState(state, snapshot, clock.date);
        this.recordEvent(state, 'post_close', 'reconciled', `盘后已核对 ${snapshot.positions.length} 只持仓和 ${snapshot.orders.length} 笔当日委托`);
      }

      if (window === 'open' || window === 'near_close') {
        if (pendingRemaining === 0) {
          this.markWindowCompleted(state, clock.date, window);
        } else {
          console.log('[paper] window still has pending orders, not marking completed', {
            window,
            trading_date: clock.date,
            pending_remaining: pendingRemaining,
          });
        }
      } else {
        this.markWindowCompleted(state, clock.date, window);
      }
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
      const accountOnly = isAccountSyncOnlyPeriod(clock, []);
      const snapshot = accountOnly
        ? await this.readAndObserveAccountOnly(state, traceId, source)
        : await this.readAndObserveAccount(state, traceId, source);
      this.initializeCapital(state, snapshot);
      this.reconcileUncertainInstructions(state, snapshot, traceId);
      this.reconcileState(state, snapshot, clock.date);
      this.expirePendingPlans(state, clock, this.cachedTradingCalendar);
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

  setTradingCalendar(calendar: readonly string[]) {
    this.cachedTradingCalendar = [...calendar];
    this.lastCalendarRefreshAt = this.now().getTime();
  }

  private async buildOverview(context: PaperMarketContext, traceId: string): Promise<PaperOverview> {
    const state = await this.getState();
    const clock = shanghaiClock(this.now());
    const accountOnly = isAccountSyncOnlyPeriod(clock, context.calendar ?? []);
    const snapshot = accountOnly
      ? await this.readAndObserveAccountOnly(state, traceId, 'overview')
      : await this.readAndObserveAccount(state, traceId, 'overview');
    this.initializeCapital(state, snapshot);
    this.reconcileUncertainInstructions(state, snapshot, traceId);
    this.reconcileState(state, snapshot, clock.date);
    this.expirePendingPlans(state, clock, context.calendar ?? []);
    if (!accountOnly) {
      await this.ensurePreviousClosePlan(state, snapshot, context, clock.date, traceId);
      await this.ensureSameDayCloseSignals(state, snapshot, context, clock, traceId);
    }
    await this.persist(state);
    await this.audit.info('paper_trading', 'overview_built', {
      traceId,
      data: {
        ranking_date: context.rankingDate,
        account_only: accountOnly,
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

  private resolveActiveStrategy(state: PaperTradingRuntimeState): T1StrategyConfig {
    if (!state.strategy_config) return this.strategy;
    const maxPositions = Math.max(1, Math.trunc(state.strategy_config.maxPositions));
    return createT1StrategyConfig({
      ...this.strategy,
      ...state.strategy_config,
      maxCandidates: Math.max(state.strategy_config.maxCandidates, maxPositions * 3),
    });
  }

  private planStrategyFields(strategy: T1StrategyConfig) {
    return {
      target_position_pct: Math.min(100, strategy.maxPositions * strategy.positionSizePct),
      position_size_pct: strategy.positionSizePct,
      max_positions: strategy.maxPositions,
      max_entries_per_day: strategy.maxEntriesPerDay,
      max_hold_days: strategy.maxHoldDays,
      stop_loss_pct: strategy.stopLossPct,
      take_profit_pct: strategy.takeProfitPct,
    };
  }

  private composeOverview(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    context: PaperMarketContext,
    connection: PaperOverview['connection'],
  ): PaperOverview {
    const strategy = this.resolveActiveStrategy(state);
    const clock = shanghaiClock(this.now());
    const timing = assessMarketTiming(context);
    const totalMarketValue = round(snapshot.positions.reduce((sum, item) => sum + item.market_value, 0), 2);
    const currentPositionPct = snapshot.totalAssets ? round(totalMarketValue / snapshot.totalAssets * 100, 1) : 0;
    const pnlAmount = round(snapshot.positions.reduce((sum, item) => sum + item.pnl_amount, 0), 2);
    const costBasis = snapshot.positions.reduce((sum, item) => sum + item.cost_price * item.shares, 0);
    const active = state.instructions.filter(isActiveInstruction);
    const trackedByCode = new Map(state.tracked_positions.map((position) => [position.stock_code, position]));
    const planOrders = active.map((instruction) => this.instructionToOrder(instruction));
    // 活动中的计划只在 plan.orders 展示；状态变更（pending→uncertain 等）在原记录上更新，不进入 history。
    const history = [...state.instructions]
      .filter((instruction) => !isActiveInstruction(instruction))
      .reverse()
      .map((instruction) => ({
        ...this.instructionToOrder(instruction, instruction.execution_price ?? instruction.signal_price),
        signal_date: instruction.signal_date,
        rank: instruction.rank,
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
        ...this.planStrategyFields(strategy),
        engine_version: PAPER_ENGINE_VERSION,
        methodology: '当日收盘生成信号；行情好时次日开盘买入、临近收盘卖出，行情不好时开盘卖出、临近收盘买入；策略判断全部由 Node.js 完成，AppleScript 只负责同花顺模拟账户查询与委托执行。',
        sentiment: timing.sentiment,
        ranking_date: context.rankingDate,
        market_reason: `当前行情${timing.weak ? '偏弱（卖出开盘、买入临收盘）' : '可交易（买入开盘、卖出临收盘）'}；${timing.reason}。最多持仓 ${strategy.maxPositions} 只、单票 ${strategy.positionSizePct}%、每日最多新增 ${strategy.maxEntriesPerDay} 只、止损 ${strategy.stopLossPct}%、止盈 +${strategy.takeProfitPct}%、最长持有 ${strategy.maxHoldDays} 个交易日。`,
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
    if (state.last_signal_date === signalDate) {
      await this.audit.info('strategy', 'close_signals_already_generated', {
        traceId,
        data: { trading_date: tradingDate, signal_date: signalDate },
      });
      return state.instructions
        .filter((instruction) => instruction.signal_date === signalDate)
        .map((instruction) => this.instructionToOrder(instruction));
    }

    this.expirePendingPlans(state, shanghaiClock(this.now()), context.calendar ?? []);
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
    const executionCalendar = this.effectiveTradingCalendar(context.calendar ?? []);
    if (nextTradingDateAfter(signalDate, executionCalendar) !== tradingDate) return [];
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
      this.strategy.minEntryScore,
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
      const signalScore = Number(candidate.total_score ?? 0);
      const sizing = calculateEntrySize(estimatedCash, referenceCapital, signalPrice, this.strategy, signalScore);
      const status = sizing ? 'pending' as const : 'skipped' as const;
      const reason = sizing
        ? withExecutionTiming(`信号日${signalDate} 排名#${candidate.rank}`, 'buy', executionWindow)
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
        signal_score: signalScore,
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
  ): Promise<{ snapshot: SimulatedAccountSnapshot; results: PaperOrder[]; pendingRemaining: number }> {
    let snapshot = initialSnapshot;
    const results: PaperOrder[] = [];
    this.reconcileUncertainInstructions(state, snapshot, traceId);
    const inFlight = state.instructions.filter((instruction) => instruction.status === 'submitting');
    if (inFlight.length > 0) {
      throw new Error(`存在 ${inFlight.length} 笔正在提交中的委托，请稍候重试`);
    }
    const executionCalendar = this.effectiveTradingCalendar(context.calendar ?? []);
    const eligible = (instruction: PaperStrategyInstruction) => (
      instruction.status === 'pending'
      && nextTradingDateAfter(instruction.signal_date, executionCalendar) === tradingDate
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
      try {
        await this.submitBrokerOrder(state, instruction, order, traceId);
      } catch (error) {
        if (instruction.status !== 'uncertain') throw error;
        await this.audit.warn('strategy', 'sell_submission_aborted', {
          traceId,
          data: { instruction, error: error instanceof Error ? error.message : String(error) },
        });
        break;
      }
      if (instruction.status === 'submitted') {
        results.push({ ...this.instructionToOrder(instruction, instruction.execution_price), status: '已提交并回查' });
        this.recordEvent(state, executionWindow, 'sell_submitted', `卖出 ${instruction.stock_code} ${quantity} 股`, instruction.stock_code);
      } else if (instruction.status === 'pending') {
        this.recordEvent(state, executionWindow, 'sell_retryable', `卖出 ${instruction.stock_code} 提交失败，已恢复待执行`, instruction.stock_code);
      }
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
      // 用计划时记录的总分重算仓位：不传的话执行量会比计划量大（缩放系数退回 1）。
      const sizing = calculateEntrySize(availableCash, referenceCapital, quote, this.strategy, instruction.signal_score);
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
      try {
        await this.submitBrokerOrder(state, instruction, order, traceId);
      } catch (error) {
        if (instruction.status !== 'uncertain') throw error;
        await this.audit.warn('strategy', 'buy_submission_aborted', {
          traceId,
          data: { instruction, error: error instanceof Error ? error.message : String(error) },
        });
        break;
      }
      if (instruction.status === 'submitted') {
        results.push({ ...this.instructionToOrder(instruction, instruction.execution_price), status: '已提交并回查' });
        availableCash = round(availableCash - sizing.totalCost, 2);
        occupiedCodes.add(instruction.stock_code);
        this.recordEvent(state, executionWindow, 'buy_submitted', `买入 ${instruction.stock_code} ${sizing.shares} 股`, instruction.stock_code);
      } else if (instruction.status === 'pending') {
        this.recordEvent(state, executionWindow, 'buy_retryable', `买入 ${instruction.stock_code} 提交失败，已恢复待执行`, instruction.stock_code);
      }
    }

    if (results.length > 0) snapshot = await this.readAndObserveAccount(state, traceId, `${executionWindow}:after_orders`);
    const pendingRemaining = this.countPendingWindowOrders(
      state,
      tradingDate,
      executionWindow,
      immediate,
      context.calendar ?? [],
    );
    await this.audit.info('strategy', 'window_execution_completed', {
      traceId,
      data: { trading_date: tradingDate, execution_window: executionWindow, immediate, results, pending_remaining: pendingRemaining, final_account: snapshot },
    });
    return { snapshot, results, pendingRemaining };
  }

  private countPendingWindowOrders(
    state: PaperTradingRuntimeState,
    tradingDate: string,
    executionWindow: PlanExecutionWindow,
    immediate: boolean,
    calendar: readonly string[] = [],
  ): number {
    const executionCalendar = this.effectiveTradingCalendar(calendar);
    return state.instructions.filter((instruction) => (
      instruction.status === 'pending'
      && nextTradingDateAfter(instruction.signal_date, executionCalendar) === tradingDate
      && (immediate || (instruction.execution_window ?? 'open') === executionWindow)
    )).length;
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

  private effectiveTradingCalendar(calendar: readonly string[] = []): string[] {
    return [...new Set([...this.cachedTradingCalendar, ...calendar]
      .map(compactDate)
      .filter((item) => /^\d{8}$/.test(item)))]
      .sort();
  }

  /**
   * 计划是否已错过执行日。纯判定，不改状态，供只读预检和清算共用。
   */
  private planExpired(
    instruction: PaperStrategyInstruction,
    clock: ReturnType<typeof shanghaiClock>,
    executionCalendar: readonly string[],
  ): boolean {
    if (instruction.status !== 'pending') return false;
    const executionDate = nextTradingDateAfter(instruction.signal_date, executionCalendar);
    if (!executionDate) return false;
    return executionDate < clock.date
      || (executionDate === clock.date && clock.minute >= MARKET_CLOSE_MINUTE);
  }

  /**
   * 过期清算的唯一入口：不读同花顺、不看交易日、不看自动化开关，
   * 只按"执行日是否已过"这一事实判定，所以同花顺离线、周末、夜间都能正确清算。
   * 无到期项时直接返回，不进互斥队列也不落盘。
   */
  async expireStalePlans(): Promise<number> {
    // 配了日历源却还没拿到日历时先不清算：此时 nextTradingDateAfter 会退化成
    // 纯工作日推算，跨节假日会把执行日算早一天，导致计划提前过期。
    if (this.calendarRefresher && this.cachedTradingCalendar.length === 0) return 0;
    const preview = await this.getState();
    const previewClock = shanghaiClock(this.now());
    const previewCalendar = this.effectiveTradingCalendar();
    if (!preview.instructions.some((instruction) => this.planExpired(instruction, previewClock, previewCalendar))) {
      return 0;
    }
    return this.exclusive(async () => {
      const state = await this.getState();
      const clock = shanghaiClock(this.now());
      const expired = this.expirePendingPlans(state, clock, this.cachedTradingCalendar);
      if (expired === 0) return 0;
      await this.persist(state);
      await this.audit.info('paper_trading', 'plans_expired', {
        data: { expired, trading_date: clock.date, observed_at: clock.timestamp },
      });
      this.broadcast('plans_expired', { expired, trading_date: clock.date });
      return expired;
    });
  }

  private expirePendingPlans(
    state: PaperTradingRuntimeState,
    clock: ReturnType<typeof shanghaiClock>,
    calendar: readonly string[] = [],
  ): number {
    const executionCalendar = this.effectiveTradingCalendar(calendar);
    let expired = 0;
    for (const instruction of state.instructions) {
      if (!this.planExpired(instruction, clock, executionCalendar)) continue;
      const executionDate = nextTradingDateAfter(instruction.signal_date, executionCalendar)!;
      instruction.status = 'expired';
      instruction.completed_at = clock.timestamp;
      const windowLabel = executionWindowLabel(instruction.execution_window ?? 'open');
      const failureReason = this.findWindowFailureReason(state, executionDate, instruction.execution_window ?? 'open');
      instruction.reason = failureReason
        ? `${instruction.reason}；${displayDate(executionDate)} ${windowLabel}计划当日未执行，已过期（${failureReason}）`
        : `${instruction.reason}；${displayDate(executionDate)} ${windowLabel}计划当日未执行，已过期`;
      expired += 1;
    }
    if (expired > 0) {
      this.recordEvent(state, 'system', 'plans_expired', `${expired} 个当日未执行计划已置为过期`);
    }
    return expired;
  }

  private findWindowFailureReason(
    state: PaperTradingRuntimeState,
    executionDate: string,
    executionWindow: PlanExecutionWindow,
  ): string | null {
    const failures = state.events.filter(
      (event) => event.type === 'window_failed'
        && event.trading_date === executionDate
        && event.window === executionWindow,
    );
    if (failures.length === 0) return null;
    // Take the last failure message and summarize it
    const lastFailure = failures.at(-1)!;
    return summarizeSubmissionError(lastFailure.message, 120);
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

  private async readAndObserveAccountOnly(
    state: PaperTradingRuntimeState,
    traceId: string,
    stage: string,
  ): Promise<SimulatedAccountSnapshot> {
    const context: BrokerCallContext = {
      traceId,
      stage,
      source: 'paper_trading',
      hintStockCodes: state.last_account_observation?.positions.map((position) => position.stock_code) ?? [],
    };
    const snapshot = await this.broker.snapshotAccountOnly(context);
    const previousOrders = state.last_account_observation?.orders ?? [];
    const merged: SimulatedAccountSnapshot = {
      ...snapshot,
      orders: previousOrders.map((order) => ({ ...order })),
    };
    await this.audit.info('account_monitor', 'account_only_sync', {
      traceId,
      data: {
        stage,
        hint_stock_codes: context.hintStockCodes,
        positions: merged.positions.length,
        preserved_orders: merged.orders.length,
      },
    });
    await this.observeAccountChanges(state, merged, traceId, stage);
    return merged;
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
    try {
      await this.audit.info('order', 'submission_started', {
        traceId,
        data: { instruction, order },
      });
    } catch (error) {
      instruction.status = 'pending';
      instruction.submitted_at = undefined;
      await this.persist(state);
      throw error;
    }
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
      if (isAmbiguousSubmissionFailure(message)) {
        instruction.status = 'uncertain';
        instruction.broker_status = `提交结果不确定：${summarizeSubmissionError(message)}`;
        state.automation = { ...state.automation, last_error: summarizeSubmissionError(message) };
        this.recordEvent(state, instruction.execution_window ?? 'open', 'order_submission_uncertain', `${instruction.stock_code} ${summarizeSubmissionError(message)}`, instruction.stock_code);
        await this.persist(state);
        await this.audit.error('order', 'submission_uncertain', {
          traceId,
          data: { instruction, order },
          error,
        });
        throw error;
      }
      instruction.status = 'pending';
      instruction.submitted_at = undefined;
      instruction.broker_status = `上次提交失败：${summarizeSubmissionError(message)}`;
      state.automation = { ...state.automation, last_error: summarizeSubmissionError(message) };
      await this.persist(state);
      await this.audit.warn('order', 'submission_failed_retryable', {
        traceId,
        data: { instruction, order },
        error,
      });
      return { verified: false, brokerOutput: message };
    }
  }

  private reconcileUncertainInstructions(
    state: PaperTradingRuntimeState,
    snapshot: SimulatedAccountSnapshot,
    traceId: string,
  ): number {
    const timestamp = shanghaiClock(this.now()).timestamp;
    const resolved: PaperStrategyInstruction[] = [];
    for (const instruction of state.instructions) {
      if (instruction.status !== 'uncertain') continue;
      const brokerOrder = snapshot.orders.find((order) => (
        order.side === instruction.side
        && order.stock_code === instruction.stock_code
      ));
      const position = snapshot.positions.find((item) => item.stock_code === instruction.stock_code);
      if (instruction.side === 'sell') {
        if (!position) {
          instruction.status = 'filled';
          instruction.completed_at = timestamp;
          instruction.broker_status = '同花顺持仓已清零，视为已卖出';
          resolved.push(instruction);
        } else if (brokerOrder) {
          instruction.status = 'submitted';
          instruction.broker_status = brokerOrder.status || '委托列表已核对';
          resolved.push(instruction);
        } else {
          instruction.status = 'pending';
          instruction.submitted_at = undefined;
          instruction.broker_status = '同花顺无对应委托，已恢复待执行';
          resolved.push(instruction);
        }
        continue;
      }
      if (position) {
        instruction.status = 'filled';
        instruction.completed_at = timestamp;
        instruction.broker_status = '持仓已核对';
        resolved.push(instruction);
      } else if (brokerOrder) {
        instruction.status = 'submitted';
        instruction.broker_status = brokerOrder.status || '委托列表已核对';
        resolved.push(instruction);
      } else {
        instruction.status = 'pending';
        instruction.submitted_at = undefined;
        instruction.broker_status = '同花顺无对应委托，已恢复待执行';
        resolved.push(instruction);
      }
    }
    if (resolved.length > 0) {
      console.log('[paper] reconciled uncertain instructions', {
        count: resolved.length,
        stocks: resolved.map((instruction) => instruction.stock_code),
      });
      void this.audit.info('strategy', 'uncertain_instructions_reconciled', {
        traceId,
        data: {
          resolved: resolved.map((instruction) => ({
            id: instruction.id,
            side: instruction.side,
            stock_code: instruction.stock_code,
            status: instruction.status,
            broker_status: instruction.broker_status,
          })),
        },
      });
    }
    return resolved.length;
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
      reason: instruction.reason,
      window: `${timing}·${instruction.side === 'sell' ? '卖出' : '买入'}`,
      execution_window: executionWindow,
      signal_date: instruction.signal_date,
      rank: instruction.rank,
      cancelable: instruction.status === 'submitted',
      broker_status: instruction.broker_status,
      created_at: instruction.created_at,
      submitted_at: instruction.submitted_at,
    };
  }

  private async tickScheduler() {
    if (this.schedulerTickInFlight) return this.schedulerTickInFlight;
    this.schedulerTickInFlight = (async () => {
      // 过期清算独立于自动化开关、交易日判定和同花顺可用性：执行日已过就是既成事实。
      // 挂在 monitorAccount 上时，同花顺一离线当天计划就永远停在"待执行"。
      try {
        await this.expireStalePlans();
      } catch (error) {
        await this.audit.error('paper_trading', 'expire_stale_plans_failed', { error });
      }

      const state = await this.getState();
      const clock = shanghaiClock(this.now());
      if (!state.automation.enabled || state.automation.paused_today) return;

      this.calendarRefreshedThisTick = false;
      if (this.calendarRefresher) {
        await this.refreshTradingCalendar(false);
      }
      const calendar = this.cachedTradingCalendar;
      if (!isTradingDay(clock, calendar, { calendarRefreshed: this.calendarRefreshedThisTick })) return;

      // 预热要在 due 计算之前：09:25/14:50/15:03 都早于各自服务的窗口，
      // 此时没有 due，拉起的 120s 不会挤占成交时间。
      await this.warmUpThs(clock, randomUUID());

      const nowMs = this.now().getTime();

      let due: TradingWindow | null = null;
      if (clock.minute >= 9 * 60 + 31 && clock.minute < 10 * 60 && !this.isWindowCompleted(state, clock.date, 'open')) {
        due = 'open';
      } else if (clock.minute >= NEAR_CLOSE_WINDOW_START_MINUTE && clock.minute < MARKET_CLOSE_MINUTE && !this.isWindowCompleted(state, clock.date, 'near_close')) {
        due = 'near_close';
      } else if (clock.minute >= 15 * 60 + 5 && clock.minute <= LATE_WINDOW_END_MINUTE && !this.isWindowCompleted(state, clock.date, 'close')) {
        due = 'close';
      } else if (clock.minute >= 15 * 60 + 10 && clock.minute <= LATE_WINDOW_END_MINUTE && !this.isWindowCompleted(state, clock.date, 'post_close')) {
        due = 'post_close';
      }
      if (due) {
        const retryKey = `${clock.date}:${due}`;
        if (nowMs < (this.windowRetry.get(retryKey)?.retryAfter ?? 0)) return;
        try {
          await this.runWindow(due);
          this.windowRetry.delete(retryKey);
        } catch (error) {
          const failures = (this.windowRetry.get(retryKey)?.failures ?? 0) + 1;
          this.windowRetry.set(retryKey, {
            failures,
            retryAfter: this.now().getTime() + windowRetryDelayMs(due, failures),
          });
          this.pruneWindowRetry(clock.date);
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

  private pruneWindowRetry(tradingDate: string) {
    for (const key of this.windowRetry.keys()) {
      if (!key.startsWith(`${tradingDate}:`)) this.windowRetry.delete(key);
    }
  }

  /**
   * 保证同花顺可用。未注入 thsReadiness 时是 no-op（测试与非 macOS 环境）。
   * 拉不起来不抛错：让窗口自己去撞券商调用并走既有的失败退避，
   * 这样失败原因仍是券商的原始报错，不会被"拉起失败"掩盖。
   */
  private async ensureThsReady(
    state: PaperTradingRuntimeState,
    reason: string,
    timeoutMs: number,
    traceId: string,
  ): Promise<void> {
    if (!this.thsReadiness) return;
    try {
      const result = await this.thsReadiness.ensureReady(reason, { timeoutMs });
      if (result.ready) {
        if (result.launched) {
          this.recordEvent(state, 'system', 'ths_launched', `同花顺已自动拉起并就绪（${reason}）`);
        }
        return;
      }
      const message = result.message ?? '同花顺仍不可用';
      state.automation = { ...state.automation, last_error: summarizeSubmissionError(message) };
      this.recordEvent(state, 'system', 'ths_not_ready', `同花顺就绪失败（${reason}）：${summarizeSubmissionError(message, 120)}`);
      await this.audit.warn('paper_trading', 'ths_not_ready', {
        traceId,
        data: { reason, timeout_ms: timeoutMs, message },
      });
    } catch (error) {
      await this.audit.error('paper_trading', 'ths_ensure_ready_failed', { traceId, data: { reason }, error });
    }
  }

  /** 窗口前预热：把耗时的 open -a + 登录 + 切模拟 tab 挪到成交窗口之外。 */
  private async warmUpThs(clock: ReturnType<typeof shanghaiClock>, traceId: string): Promise<void> {
    if (!this.thsReadiness) return;
    const warmup = thsWarmupSlot(clock.minute);
    if (!warmup) return;
    const key = `${clock.date}:${warmup.slot}`;
    if (this.warmedUpSlots.has(key)) return;
    this.warmedUpSlots.add(key);
    for (const existing of this.warmedUpSlots) {
      if (!existing.startsWith(`${clock.date}:`)) this.warmedUpSlots.delete(existing);
    }
    await this.exclusive(async () => {
      const state = await this.getState();
      await this.ensureThsReady(state, `warmup:${warmup.slot}`, warmup.timeoutMs, traceId);
      await this.persist(state);
    });
  }

  private requireMarketContext(window: TradingWindow, traceId: string): Promise<PaperMarketContext> {
    if (!this.marketDataProvider) throw new Error('Node 交易核心未配置市场数据提供器');
    return this.marketDataProvider(window, traceId);
  }

  private hydrateStrategyFromState(stored: PaperTradingRuntimeState) {
    if (!stored.strategy_config) return;
    this.strategy = this.resolveActiveStrategy(stored);
    this.strategyHydratedFromState = true;
    console.log('[paper] restored strategy from state', {
      run_id: stored.applied_backtest_run_id ?? null,
      strategy: stored.strategy_config,
    });
  }

  private getState(): Promise<PaperTradingRuntimeState> {
    if (this.statePromise) return this.statePromise;
    const promise = this.stateStore.load().then((stored) => {
      const timestamp = shanghaiClock(this.now()).timestamp;
      if (!stored || stored.schema_version !== 1) return defaultState(timestamp);
      const state = {
        ...defaultState(timestamp),
        ...stored,
        engine_version: PAPER_ENGINE_VERSION,
        automation: { ...defaultAutomation(), ...stored.automation },
        completed_windows: stored.completed_windows ?? {},
        instructions: (stored.instructions ?? []).map((instruction) => normalizeInstructionOnLoad(instruction)),
        tracked_positions: stored.tracked_positions ?? [],
        events: stored.events ?? [],
      };
      this.hydrateStrategyFromState(state);
      return state;
    });
    this.statePromise = promise;
    return promise;
  }

  private async persist(state: PaperTradingRuntimeState) {
    const clock = shanghaiClock(this.now());
    state.updated_at = clock.timestamp;
    state.engine_version = PAPER_ENGINE_VERSION;
    state.automation.next_window = this.nextWindowLabel(state, clock);
    state.events = state.events.slice(-200);
    // 策略计划是交易审计账本，已成交、跳过、失败、已撤和过期记录都永久保留。
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
    if (clock.minute < NEAR_CLOSE_WINDOW_START_MINUTE && !this.isWindowCompleted(state, clock.date, 'near_close')) return '下一窗口：14:57 临收盘执行';
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
    if (window === 'near_close' && (clock.minute < NEAR_CLOSE_WINDOW_START_MINUTE || clock.minute >= MARKET_CLOSE_MINUTE)) {
      throw new Error('临收盘执行窗口仅允许在交易日 14:57-15:00 运行');
    }
    if (window === 'close' && clock.minute < MARKET_CLOSE_MINUTE) {
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

  private broadcastTradingSession(calendar: readonly string[] = this.cachedTradingCalendar) {
    const clock = shanghaiClock(this.now());
    this.broadcast('trading_session', buildTradingSession(clock, calendar));
  }

  private shouldRefreshTradingCalendar(clock: ReturnType<typeof shanghaiClock>): boolean {
    const nowMs = this.now().getTime();
    const latestDay = this.cachedTradingCalendar.at(-1) ?? '';
    const calendarStale = clock.weekday >= 1 && clock.weekday <= 5
      && clock.date > latestDay
      && clock.minute >= 8 * 60;
    const intervalMs = calendarStale
      ? TRADING_CALENDAR_STALE_REFRESH_INTERVAL_MS
      : this.calendarRefreshIntervalMs;
    return nowMs - this.lastCalendarRefreshAt >= intervalMs;
  }

  private refreshTradingCalendar(force = false): Promise<string[]> {
    if (!this.calendarRefresher) return Promise.resolve(this.cachedTradingCalendar);
    if (this.calendarRefreshInFlight) return this.calendarRefreshInFlight;
    const clock = shanghaiClock(this.now());
    if (!force && !this.shouldRefreshTradingCalendar(clock)) {
      return Promise.resolve(this.cachedTradingCalendar);
    }
    this.calendarRefreshInFlight = (async () => {
      try {
        const previousLatest = this.cachedTradingCalendar.at(-1) ?? '';
        const previousLength = this.cachedTradingCalendar.length;
        const calendar = await this.calendarRefresher!();
        this.cachedTradingCalendar = [...calendar];
        this.lastCalendarRefreshAt = this.now().getTime();
        this.calendarRefreshedThisTick = true;
        const nextLatest = calendar.at(-1) ?? '';
        if (force || nextLatest !== previousLatest || calendar.length !== previousLength) {
          this.broadcastTradingSession(calendar);
        }
        await this.audit.info('paper_trading', 'trading_calendar_refreshed', {
          data: {
            latest_day: nextLatest,
            calendar_days: calendar.length,
            today_included: calendar.includes(clock.date),
            forced: force,
          },
        });
        return calendar;
      } catch (error) {
        await this.audit.error('paper_trading', 'trading_calendar_refresh_failed', { error });
        throw error;
      } finally {
        this.calendarRefreshInFlight = null;
      }
    })();
    return this.calendarRefreshInFlight;
  }
}
