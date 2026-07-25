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

export interface AuditLoggerLike {
  debug(component: string, event: string, meta?: Record<string, unknown>): void | Promise<void>;
  info(component: string, event: string, meta?: Record<string, unknown>): void | Promise<void>;
  warn(component: string, event: string, meta?: Record<string, unknown>): void | Promise<void>;
  error(component: string, event: string, meta?: Record<string, unknown>): void | Promise<void>;
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