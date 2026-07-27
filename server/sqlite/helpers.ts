import type { KLineData } from '../historical-market.js';
import type { StrategyAction } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

export interface LimitUpRecord {
  date: string;
  stock_code: string;
  stock_name: string;
  sector_code: string;
  sector_name: string;
  continue_num: number;
  reason_type: string;
  sector_change: number;
  latest: number | null;
  change_rate: number | null;
}

/**
 * 某板块关联的全部个股（由 limit_up_record 多日累积、按 stock_code 去重保留最新 date 一条）。
 * 价格字段 (latest/change_rate) 仅在 K 线最新日 ≥ 板块最新行情日 时才有效：
 * 历史涨停的个股需要等异步 K 线刷新覆盖到最新交易日，才能如实显示当下涨跌幅。
 *  - kline_date: 该个股在 stock_daily_price 中的最新日期（YYYY-MM-DD，可能为 null 表示无 K 线）
 *  - latest_analysis_date: 当前 limit_up_record 的最大日期（用于判断最新行情是否已就绪）
 *  - price_fresh: 当 kline_date 非 null 且 ≥ latest_analysis_date 时为 true
 */
export interface SectorStockRecord {
  date: string;
  stock_code: string;
  stock_name: string;
  sector_code: string;
  sector_name: string;
  continue_num: number;
  reason_type: string;
  sector_change: number;
  /** 涨停当时的收盘价（仅日期层面参照，与「当下最新价」不同）。 */
  latest: number | null;
  change_rate: number | null;
  /** 当前 K 线最新日期 (YYYY-MM-DD)，null 表示尚无 K 线记录。 */
  kline_date: string | null;
  /** 当前 K 线最新收盘价（仅在 price_fresh 时才反映「当下」价格）。 */
  kline_latest: number | null;
  /** 当前 K 线最新涨跌幅%。 */
  kline_change_rate: number | null;
  /** 当前 limit_up_record 的最大日期，作为「最新行情日」基准。 */
  latest_analysis_date: string;
  /** 价格字段是否反映最新行情（K 线最新日 ≥ 最新行情日）。 */
  price_fresh: boolean;
}

export interface SectorTrendRecord {
  date: string;
  sector_code: string;
  sector_name: string;
  state_id: number;
  state_name: string;
  trend: string;
  latest: number | null;
  ma5: number | null;
  ma20: number | null;
  near_high: string;
  volume_trend: string;
  adx: number | null;
  plus_di: number | null;
  minus_di: number | null;
  downgraded: number;
  /** 多周期交叉验证的改写方向：'up' 升级 / 'down' 降级 / null 未改写。 */
  adjust_direction: string | null;
  original_state_id: number | null;
  original_state_name: string | null;
  strategy_action: string;
  strategy_label: string;
  strategy_position: string;
  computed_at: string;
}

export interface DailyPriceCoverage {
  stock_code: string;
  stock_name: string;
  first_date: string;
  last_date: string;
  row_count: number;
}

export interface StoredDailyPrice extends KLineData {
  stock_code: string;
  stock_name: string;
}

export interface RankingFactorRecord {
  date: string;
  stock_code: string;
  factor_name: string;
  val_numeric: number | null;
  val_text: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 同花顺板块 K 线周期常量：01=日 / 11=周 / 21=月。 */
export const BLOCK_PERIOD_DAILY = '01' as const;
export const BLOCK_PERIOD_WEEKLY = '11' as const;
export const BLOCK_PERIOD_MONTHLY = '21' as const;
export type BlockPeriod = typeof BLOCK_PERIOD_DAILY | typeof BLOCK_PERIOD_WEEKLY | typeof BLOCK_PERIOD_MONTHLY;

export const STATE_NAMES: Record<number, string> = {
  0: '数据不足',
  1: '主线主升',
  2: '高位滞涨',
  3: '首次回调',
  4: '箱体震荡',
  5: '缩量无序',
  6: '阴跌不止',
  7: '恐慌暴跌',
  8: '筑底成功',
};

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

export function compactDate(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

export function isoDate(value: unknown): string {
  const compact = compactDate(value);
  if (!compact) return '';
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numberValue(value: unknown, fallback = 0): number {
  return finiteNumber(value) ?? fallback;
}

export function textValue(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

export function stockMarket(code: string): string {
  if (/^(4|8|92)/.test(code)) return 'BJ';
  return /^(6|68|5|9)/.test(code) ? 'SH' : 'SZ';
}

export function validStockCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

export function normalizedSymbol(value: unknown): string {
  const symbol = String(value ?? '').trim().toLowerCase();
  return /^(sh|sz)\d{6}$/.test(symbol) ? symbol : '';
}

export function strategyAction(value: unknown): StrategyAction {
  return ['accumulate', 'trade', 'reduce', 'ignore'].includes(String(value))
    ? value as StrategyAction
    : 'ignore';
}

export function rowToKline(row: Record<string, unknown>): KLineData {
  const changeRate = finiteNumber(row.change_rate);
  return {
    date: textValue(row.date),
    open: numberValue(row.open),
    close: numberValue(row.close),
    high: numberValue(row.high),
    low: numberValue(row.low),
    volume: numberValue(row.volume),
    amount: numberValue(row.amount),
    ...(changeRate == null ? {} : { changeRate }),
  };
}