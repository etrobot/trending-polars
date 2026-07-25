import type { DataStore } from './data-store.js';
import { compactDate } from './format.js';
import { fetchTencentKlines } from './historical-market.js';

export const SHANGHAI_INDEX_SYMBOL = 'sh000001';
export const SHANGHAI_INDEX_NAME = '上证指数';
/** A 股约 252 个交易日/年，3 年约 756 条；留少量余量避免边界误判。 */
export const SHANGHAI_INDEX_MIN_TRADING_DAYS = 700;
export const SHANGHAI_INDEX_FETCH_LIMIT = 1000;

function compactTradingDay(value: string): string {
  return value.replace(/\D/g, '').slice(0, 8);
}

/** 在交易日历中取 <= ceiling 的最近一个交易日。 */
export function latestTradingDayOnOrBefore(calendar: string[], ceiling: string): string | null {
  const bound = compactTradingDay(ceiling);
  if (!bound) return calendar.at(-1) ? compactTradingDay(calendar.at(-1)!) : null;
  const eligible = calendar
    .map(compactTradingDay)
    .filter((day) => day && day <= bound);
  return eligible.at(-1) ?? null;
}

async function loadTradingCalendar(store: DataStore): Promise<string[]> {
  const indexDays = await store.getIndexTradingDays(SHANGHAI_INDEX_SYMBOL);
  if (indexDays.length) return indexDays;
  const history = await store.getHistoricalMarket();
  return history?.calendar ?? [];
}

/**
 * 解析实际使用的交易日：优先上证指数本地交易日历，周末/节假日自动回退到最近交易日。
 * 若调用方显式指定了晚于本地日历的最新日期（如今日尚未落库），则保留该日期。
 */
export async function resolveLatestTradingDate(store: DataStore, asOf?: unknown): Promise<string> {
  const today = compactDate(new Date()).slice(0, 8);
  const explicit = compactTradingDay(String(asOf ?? ''));
  const hasExplicit = /^\d{8}$/.test(explicit);
  const ceiling = hasExplicit ? explicit : today;
  const calendar = await loadTradingCalendar(store);
  const latestStored = compactTradingDay(calendar.at(-1) ?? '');

  if (hasExplicit) {
    if (calendar.some((day) => compactTradingDay(day) === explicit)) return explicit;
    if (latestStored && explicit > latestStored) return explicit;
  }

  const resolved = latestTradingDayOnOrBefore(calendar, ceiling);
  if (resolved) {
    if (resolved !== ceiling) {
      console.log(`[market-date] ${ceiling} 非交易日，使用最近交易日 ${resolved}`);
    }
    return resolved;
  }

  const latestAnalysis = await store.getLatestAnalysisDate();
  if (latestAnalysis && latestAnalysis <= ceiling) {
    console.log(`[market-date] 无交易日历，回退到最近分析日 ${latestAnalysis}`);
    return latestAnalysis;
  }

  console.log(`[market-date] 无交易日历，回退到 ${ceiling}`);
  return ceiling;
}

/** 3 年前的同日（Asia/Shanghai），用于判断本地库是否覆盖足够长的历史。 */
export function shanghaiIndexHistoryStartThreshold(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  const year = Number(get('year')) - 3;
  return `${year}${get('month')}${get('day')}`;
}

export function isShanghaiIndexHistorySufficient(
  tradingDays: string[],
  threshold = shanghaiIndexHistoryStartThreshold(),
): boolean {
  if (tradingDays.length < SHANGHAI_INDEX_MIN_TRADING_DAYS) return false;
  const first = compactTradingDay(tradingDays[0] ?? '');
  if (!first) return false;
  return first <= threshold;
}

export async function ensureShanghaiIndexHistory(store: DataStore): Promise<{
  backfilled: boolean;
  rows: number;
  inserted?: number;
}> {
  const tradingDays = await store.getIndexTradingDays(SHANGHAI_INDEX_SYMBOL);
  const threshold = shanghaiIndexHistoryStartThreshold();
  if (isShanghaiIndexHistorySufficient(tradingDays, threshold)) {
    console.log(
      `[bootstrap] 上证指数行情已满足 3 年覆盖：${tradingDays.length} 个交易日，最早 ${tradingDays[0]}，阈值 ${threshold}`,
    );
    return { backfilled: false, rows: tradingDays.length };
  }

  console.log(
    `[bootstrap] 上证指数行情不足：${tradingDays.length} 个交易日，最早 ${tradingDays[0] ?? '无'}，阈值 ${threshold}；正在从腾讯财经补全…`,
  );
  const klines = await fetchTencentKlines(SHANGHAI_INDEX_SYMBOL, SHANGHAI_INDEX_FETCH_LIMIT);
  if (!klines.length) {
    console.error('[bootstrap] 腾讯财经未返回上证指数行情，保留现有本地数据');
    return { backfilled: false, rows: tradingDays.length };
  }

  const inserted = await store.upsertIndexPrices(SHANGHAI_INDEX_SYMBOL, SHANGHAI_INDEX_NAME, klines);
  const after = await store.getIndexTradingDays(SHANGHAI_INDEX_SYMBOL);
  console.log(
    `[bootstrap] 上证指数补全完成：写入 ${inserted} 条，现有 ${after.length} 个交易日（${after[0] ?? '—'} ~ ${after.at(-1) ?? '—'}）`,
  );
  return { backfilled: true, rows: after.length, inserted };
}
