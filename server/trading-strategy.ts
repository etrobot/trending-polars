import pl from 'nodejs-polars';
import type { RankingRow } from '../src/types.js';
import { round } from './format.js';

export interface T1StrategyConfig {
  maxHoldDays: number;
  maxPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntriesPerDay: number;
  positionSizePct: number;
  maxCandidates: number;
  lotSize: number;
  slippageRate: number;
  commissionRate: number;
  minimumCommission: number;
  stampTaxRate: number;
}

export const DEFAULT_T1_STRATEGY: Readonly<T1StrategyConfig> = Object.freeze({
  maxHoldDays: 5,
  maxPositions: 10,
  stopLossPct: -5,
  takeProfitPct: 15,
  maxEntriesPerDay: 2,
  positionSizePct: 10,
  maxCandidates: 5,
  lotSize: 100,
  slippageRate: 0.0005,
  commissionRate: 0.0003,
  minimumCommission: 5,
  stampTaxRate: 0.0005,
});

export function createT1StrategyConfig(overrides: Partial<T1StrategyConfig> = {}): T1StrategyConfig {
  return {
    ...DEFAULT_T1_STRATEGY,
    ...overrides,
    maxHoldDays: Math.max(1, Math.trunc(overrides.maxHoldDays ?? DEFAULT_T1_STRATEGY.maxHoldDays)),
    maxPositions: Math.max(1, Math.trunc(overrides.maxPositions ?? DEFAULT_T1_STRATEGY.maxPositions)),
  };
}

export function rankEntryCandidates(
  rows: RankingRow[],
  excludedCodes: ReadonlySet<string> = new Set(),
  limit = DEFAULT_T1_STRATEGY.maxCandidates,
): RankingRow[] {
  const eligible = rows.filter((row) => !excludedCodes.has(String(row.stock_code ?? '')));
  if (!eligible.length) return [];
  return pl.DataFrame(eligible.map((row) => ({
    ...row,
    stock_code: String(row.stock_code ?? ''),
    total_score: Number(row.total_score ?? 0),
  })))
    .filter(pl.col('total_score').gtEq(40))
    .sort('total_score', true, true)
    .head(Math.max(0, Math.trunc(limit)))
    .toRecords() as unknown as RankingRow[];
}

export function commission(grossAmount: number, config: T1StrategyConfig = DEFAULT_T1_STRATEGY): number {
  return round(Math.max(config.minimumCommission, grossAmount * config.commissionRate), 2);
}

export function calculateEntrySize(
  cash: number,
  referenceCapital: number,
  price: number,
  config: T1StrategyConfig = DEFAULT_T1_STRATEGY,
): { shares: number; grossAmount: number; totalCost: number } | null {
  if (cash <= 0 || referenceCapital <= 0 || price <= 0) return null;
  const allocation = Math.min(
    cash * config.positionSizePct / 100,
    referenceCapital * config.positionSizePct / 100,
  );
  let shares = Math.floor(allocation / price / config.lotSize) * config.lotSize;
  while (shares >= config.lotSize) {
    const grossAmount = round(shares * price, 2);
    const totalCost = round(grossAmount + commission(grossAmount, config), 2);
    if (totalCost <= cash) return { shares, grossAmount, totalCost };
    shares -= config.lotSize;
  }
  return null;
}

export function exitSignalReason(
  pnlPct: number,
  holdDays: number,
  config: T1StrategyConfig = DEFAULT_T1_STRATEGY,
): string | null {
  if (pnlPct <= config.stopLossPct) return `止损信号 ${round(pnlPct, 2)}%`;
  if (pnlPct >= config.takeProfitPct) return `止盈信号 +${round(pnlPct, 2)}%`;
  if (holdDays >= config.maxHoldDays) return `持仓满 ${holdDays} 日`;
  return null;
}

export function tradingDayDistance(fromDate: string, toDate: string, calendar: readonly string[]): number {
  const normalizedFrom = fromDate.replaceAll('-', '').slice(0, 8);
  const normalizedTo = toDate.replaceAll('-', '').slice(0, 8);
  const fromIndex = calendar.indexOf(normalizedFrom);
  const toIndex = calendar.indexOf(normalizedTo);
  if (fromIndex >= 0 && toIndex >= fromIndex) return toIndex - fromIndex;

  const cursor = new Date(`${normalizedFrom.slice(0, 4)}-${normalizedFrom.slice(4, 6)}-${normalizedFrom.slice(6, 8)}T12:00:00+08:00`);
  const target = new Date(`${normalizedTo.slice(0, 4)}-${normalizedTo.slice(4, 6)}-${normalizedTo.slice(6, 8)}T12:00:00+08:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(target.getTime()) || cursor > target) return 0;
  let days = 0;
  while (cursor < target) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}
