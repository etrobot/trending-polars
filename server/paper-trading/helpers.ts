import type {
  AnalysisData,
  AutomationState,
  PaperOrder,
  PaperStrategyInstruction,
  PaperTradingRuntimeState,
  PlanExecutionWindow,
  RankingRow,
  TradingWindow,
} from '../../src/types.js';
import { round } from '../format.js';
import { type AuditLoggerLike } from '../audit-log.js';
import type { T1StrategyConfig } from '../trading-strategy.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PAPER_ENGINE_VERSION = 'node-t1-live-v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface ThsReadinessProvider {
  ensureReady(
    reason: string,
    options?: { timeoutMs?: number },
  ): Promise<{ ready: boolean; launched: boolean; message?: string }>;
}

/**
 * 各窗口的同花顺就绪预算。临收盘窗口总共只有 14:55–15:00 五分钟，
 * 塞不下整套 launch-flow（最长 120s），所以只给 45s ——
 * 正常情况 14:50 的预热已经拉好，这里只是一次 300ms 的探测。
 */
export function thsReadyTimeoutMs(window: TradingWindow): number {
  return window === 'near_close' ? 45_000 : 120_000;
}

/**
 * 窗口前的同花顺预热区间：提前把 open -a + 登录 + 切模拟 tab 跑完，
 * 不占用真正的成交窗口。用区间而非单点，服务在区间中途重启也能补上预热。
 * 每个槽位当天只跑一次（由调用方按 `${日期}:${槽位}` 去重）。
 */
export function thsWarmupSlot(minute: number): { slot: string; timeoutMs: number } | null {
  if (minute >= 9 * 60 + 25 && minute < 9 * 60 + 31) return { slot: 'open', timeoutMs: 120_000 };
  // 服务可能在盘中重启；只要仍在交易时段，就应主动恢复同花顺。
  // 14:50 之后交给临收盘预热，15:00 后则完全不再 launch-flow。
  if (minute >= 9 * 60 + 31 && minute < 14 * 60 + 50) return { slot: 'intraday', timeoutMs: 120_000 };
  if (minute >= 14 * 60 + 50 && minute < NEAR_CLOSE_WINDOW_START_MINUTE) return { slot: 'near_close', timeoutMs: 120_000 };
  // 收盘决策/盘后核对不再预热 launch-flow：15:00 后同花顺界面点控件易弹 begin failed。
  return null;
}

export interface PaperTradingServiceOptions {
  stateStore?: PaperTradingStateStore;
  marketDataProvider?: (window: TradingWindow, traceId: string) => Promise<PaperMarketContext>;
  /** 自动化开启时定期调用，刷新并返回最新交易日历（上证 sh000001）。 */
  calendarRefresher?: () => Promise<string[]>;
  /**
   * 交易窗口执行前保证同花顺可用（进程在跑且有可交互窗口）。
   * 注入而非直接依赖 AppleScript，便于测试；见 server/ths-lifecycle.ts。
   */
  thsReadiness?: ThsReadinessProvider;
  strategy?: Partial<T1StrategyConfig>;
  now?: () => Date;
  schedulerIntervalMs?: number;
  accountMonitorIntervalMs?: number;
  calendarRefreshIntervalMs?: number;
  enforceTradingWindows?: boolean;
  audit?: AuditLoggerLike;
}

export interface WindowRunResult {
  ok: true;
  window: TradingWindow;
  trading_date: string;
  status: 'completed' | 'already_completed';
  results: PaperOrder[];
  message: string;
}

export interface RunWindowOptions {
  trigger?: 'scheduled' | 'manual' | 'immediate';
}

export interface MarketTimingAssessment {
  weak: boolean;
  sentiment: string;
  marketAverageChange?: number;
  validIndices: number;
  riskIndices: number;
  bullishIndices: number;
  broadRiskIndices: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export class MemoryPaperTradingStateStore implements PaperTradingStateStore {
  private value: PaperTradingRuntimeState | null = null;

  async load() {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(state: PaperTradingRuntimeState) {
    this.value = structuredClone(state);
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

export function compactDate(value: string): string {
  return value.replaceAll('-', '').slice(0, 8);
}

export function exactLimitUpCodes(context: PaperMarketContext, date: string): Set<string> {
  const normalizedDate = compactDate(date);
  return new Set((context.limitUpRecords ?? [])
    .filter((record) => compactDate(record.date) === normalizedDate)
    .map((record) => record.stock_code));
}

export function displayDate(value: string): string {
  const date = compactDate(value);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** 取信号日后的首个交易日；日历不可用时按工作日兜底。 */
export function nextTradingDateAfter(value: string, calendar: readonly string[] = []): string | null {
  const date = compactDate(value);
  if (!/^\d{8}$/.test(date)) return null;
  const nextFromCalendar = [...new Set(calendar.map(compactDate).filter((item) => /^\d{8}$/.test(item)))]
    .sort()
    .find((item) => item > date);
  if (nextFromCalendar) return nextFromCalendar;

  const cursor = new Date(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
  ));
  if (Number.isNaN(cursor.getTime())) return null;
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return `${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, '0')}${String(cursor.getUTCDate()).padStart(2, '0')}`;
}

/** 与调度器持仓监控窗口一致：9:25–15:20 视为账户监控时段。 */
export const ACCOUNT_SYNC_SESSION_START_MINUTE = 9 * 60 + 25;
export const ACCOUNT_SYNC_SESSION_END_MINUTE = 15 * 60 + 20;
/** 立即执行（auto）最早可触发时间。 */
export const IMMEDIATE_AUTO_SESSION_START_MINUTE = 9 * 60 + 25;
/** 临收盘委托窗口：14:55 起至 15:00 收盘。 */
export const NEAR_CLOSE_WINDOW_START_MINUTE = 14 * 60 + 55;
export const MARKET_CLOSE_MINUTE = 15 * 60;
/**
 * 收盘决策/盘后核对的最晚重试时刻。这两个窗口只读本地排行并回写次日计划，
 * 不涉及成交价，所以同花顺晚间才恢复也应补跑；早收工会让次日无计划可执行。
 */
export const LATE_WINDOW_END_MINUTE = 23 * 60 + 30;
export const TRADING_CALENDAR_REFRESH_INTERVAL_MS = 5 * 60_000;
export const TRADING_CALENDAR_STALE_REFRESH_INTERVAL_MS = 60_000;

/**
 * 窗口连续失败后的退避时长。盘中窗口只有几十分钟甚至 3 分钟，退避必须压得很短
 * 才能在窗口关闭前多试几次；盘后窗口可以跑一整晚，退避拉开以免反复弹同花顺窗口。
 */
export function windowRetryDelayMs(window: TradingWindow, failures: number): number {
  const attempts = Math.max(1, Math.trunc(failures));
  const capMs = window === 'close' || window === 'post_close' ? 900_000 : 120_000;
  return Math.min(capMs, 20_000 * 2 ** (attempts - 1));
}

/**
 * 非交易日期/时段只需同步账户与持仓，跳过策略补算、行情补采和同花顺委托查询。
 */
export function isTradingDay(
  clock: ReturnType<typeof shanghaiClock>,
  calendar: readonly string[] = [],
  options?: { calendarRefreshed?: boolean },
): boolean {
  if (clock.weekday === 0 || clock.weekday === 6) return false;
  const tradingDays = calendar.map(compactDate).filter(Boolean).sort();
  if (tradingDays.length === 0) return true;
  const latestCalendarDay = tradingDays.at(-1) ?? '';
  const daySet = new Set(tradingDays);
  if (daySet.has(clock.date)) return true;
  if (clock.date < latestCalendarDay) return false;
  if (clock.date > latestCalendarDay) {
    // 日历已刷新且已过开盘，今日仍无 K 线则视为非交易日（节假日）。
    if (options?.calendarRefreshed && clock.minute >= 9 * 60 + 30) return false;
    return true;
  }
  return false;
}

export function isAccountSyncOnlyPeriod(
  clock: ReturnType<typeof shanghaiClock>,
  calendar: readonly string[] = [],
): boolean {
  if (!isTradingDay(clock, calendar)) return true;
  return clock.minute < ACCOUNT_SYNC_SESSION_START_MINUTE || clock.minute > ACCOUNT_SYNC_SESSION_END_MINUTE;
}

/**
 * 同花顺 AppleScript 只读模式：只拉资金/持仓，不查委托、不 launch-flow。
 * 15:00 收盘后切 tab / 点控件容易触发同花顺弹 "begin failed"。
 */
export function isThsBrokerReadOnlyPeriod(
  clock: ReturnType<typeof shanghaiClock>,
  calendar: readonly string[] = [],
): boolean {
  if (!isTradingDay(clock, calendar)) return true;
  return clock.minute < ACCOUNT_SYNC_SESSION_START_MINUTE || clock.minute >= MARKET_CLOSE_MINUTE;
}

export function buildTradingSession(
  clock: ReturnType<typeof shanghaiClock>,
  calendar: readonly string[] = [],
) {
  const rejection = immediateAutoWindowRejection(clock, calendar);
  return {
    shanghai_time: clock.timestamp,
    trading_date: clock.date,
    is_trading_day: isTradingDay(clock, calendar),
    calendar_latest: calendar.map(compactDate).filter(Boolean).sort().at(-1),
    immediate_execute_allowed: !rejection,
    immediate_execute_reason: rejection ?? undefined,
  };
}

/** 立即执行（auto）在非交易日期/时段的拒绝原因；可执行时返回 null。 */
export function immediateAutoWindowRejection(
  clock: ReturnType<typeof shanghaiClock>,
  calendar: readonly string[] = [],
): string | null {
  if (!isTradingDay(clock, calendar)) {
    if (clock.weekday === 0 || clock.weekday === 6) {
      return '当前不是交易日（周末），无法立即执行';
    }
    return '当前不是交易日（节假日），无法立即执行';
  }
  if (clock.minute < IMMEDIATE_AUTO_SESSION_START_MINUTE) {
    return '当前不在交易时段（09:25 后方可执行）';
  }
  return null;
}

/** 根据当前上海时间解析 auto 窗口。调用方需先通过 immediateAutoWindowRejection。 */
export function resolveAutoTradingWindow(clock: ReturnType<typeof shanghaiClock>): TradingWindow {
  const minute = clock.minute;
  if (minute < 10 * 60) return 'open';
  if (minute < NEAR_CLOSE_WINDOW_START_MINUTE) return 'open';
  if (minute < MARKET_CLOSE_MINUTE) return 'near_close';
  if (minute < 15 * 60 + 5) return 'close';
  return 'post_close';
}

export function shanghaiClock(date: Date): { date: string; minute: number; weekday: number; timestamp: string } {
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

export function defaultAutomation(): AutomationState {
  return {
    enabled: false,
    paused_today: false,
    next_window: '下一窗口：交易日 09:31 开盘执行',
  };
}

export function defaultState(timestamp: string): PaperTradingRuntimeState {
  return {
    schema_version: 1,
    engine_version: PAPER_ENGINE_VERSION,
    automation: defaultAutomation(),
    reference_capital: null,
    completed_windows: {},
    instructions: [],
    tracked_positions: [],
    events: [],
    asset_history: [],
    updated_at: timestamp,
  };
}

export function isActiveInstruction(instruction: PaperStrategyInstruction): boolean {
  return ['pending', 'submitting', 'submitted', 'uncertain'].includes(instruction.status);
}

export function instructionStatusLabel(instruction: PaperStrategyInstruction): string {
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
    expired: '已过期',
  } as Record<string, string>)[instruction.status] ?? instruction.status;
}

/**
 * 用指数状态决定成交时序，情绪只作为没有指数数据时的兜底。
 * state_id 6/7 是现有分析流程定义的风险状态，1/2/3 是偏强状态；
 * 这样"行情不好"不会因为涨停板情绪较热而误判成强市。
 */
export function assessMarketTiming(context: PaperMarketContext): MarketTimingAssessment {
  const sentiment = String(context.analysis.sentiment?.sentiment ?? 'cold');
  const marketAverageChange = Number(context.marketAverageChange);
  const hasMarketAverage = Number.isFinite(marketAverageChange);
  const indices = (context.analysis.indices ?? []).filter((item) => {
    const stateId = Number(item.state?.state_id ?? 0);
    return stateId >= 1 && stateId <= 8;
  });
  const riskIndices = indices.filter((item) => [6, 7].includes(Number(item.state?.state_id ?? 0))).length;
  const bullishIndices = indices.filter((item) => [1, 2, 3, 8].includes(Number(item.state?.state_id ?? 0))).length;
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

export function isWeakMarket(context: PaperMarketContext): boolean {
  return assessMarketTiming(context).weak;
}

export function executionWindowFor(side: 'buy' | 'sell', context: PaperMarketContext): PlanExecutionWindow {
  if (isWeakMarket(context)) return side === 'sell' ? 'open' : 'near_close';
  return side === 'buy' ? 'open' : 'near_close';
}

export function executionWindowLabel(window: PlanExecutionWindow): string {
  return window === 'open' ? '次日开盘' : '次日临近收盘';
}

export function withExecutionTiming(
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

/**
 * A 股最小价位 0.01 元，2 档 = 0.02 元。
 * 买入加两档（提高成交概率），卖出减两档（提高成交概率）。
 */
export const A_SHARE_TICK = 0.01;
export const AGGRESSIVE_TICKS = 2;

export function adjustOrderPrice(
  price: number,
  side: 'buy' | 'sell',
  window: TradingWindow,
): number {
  if (window !== 'near_close') return round(price, 2);
  const offset = side === 'buy' ? AGGRESSIVE_TICKS * A_SHARE_TICK : -AGGRESSIVE_TICKS * A_SHARE_TICK;
  return round(price + offset, 2);
}

/** 仅「已提交但回查失败」视为结果不确定；AppleScript/界面错误通常委托未发出。 */
export function isAmbiguousSubmissionFailure(message: string): boolean {
  return message.includes('委托已提交但回查失败');
}

/** 旧版本误标为 uncertain 的界面/脚本错误，应恢复为 pending 以便重试。 */
export function isRetryableUncertainInstruction(
  instruction: Pick<PaperStrategyInstruction, 'status' | 'broker_status'>,
): boolean {
  if (instruction.status !== 'uncertain') return false;
  return !isAmbiguousSubmissionFailure(instruction.broker_status ?? '');
}

export function normalizeInstructionOnLoad(instruction: PaperStrategyInstruction): PaperStrategyInstruction {
  if (instruction.status === 'submitting') {
    return {
      ...instruction,
      status: 'pending',
      submitted_at: undefined,
      broker_status: '服务重启时委托未提交完成，已恢复待执行',
    };
  }
  if (!isRetryableUncertainInstruction(instruction)) return instruction;
  const raw = instruction.broker_status ?? '';
  const detail = raw.startsWith('提交结果不确定：')
    ? raw.slice('提交结果不确定：'.length)
    : raw;
  return {
    ...instruction,
    status: 'pending',
    submitted_at: undefined,
    broker_status: detail ? `上次提交失败：${detail}` : '历史不确定状态已恢复待执行',
  };
}

export function summarizeSubmissionError(message: string, maxLength = 240): string {
  const singleLine = message.split('\n').map((line) => line.trim()).find(Boolean) ?? message.trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}
