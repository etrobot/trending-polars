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

export const STATE_NAMES: Record<number, string> = {
  0: '数据不足',
  1: '主线主升',
  2: '高位滞涨',
  3: '首次回调',
  4: '箱体震荡',
  5: '缩量无序',
  6: '阴跌不止',
  7: '恐慌暴跌',
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