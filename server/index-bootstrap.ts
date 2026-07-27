import type { DataStore } from './data-store.js';
import { compactDate } from './format.js';
import { shanghaiClock } from './paper-trading/helpers.js';
import { buildTradingCalendar } from './holiday-calendar.js';
import { fetchTencentKlines } from './historical-market.js';

export const SHANGHAI_INDEX_SYMBOL = 'sh000001';
export const SHANGHAI_INDEX_NAME = '上证指数';
/** A 股约 252 个交易日/年，3 年约 756 条；留少量余量避免边界误判。 */
export const SHANGHAI_INDEX_MIN_TRADING_DAYS = 700;
export const SHANGHAI_INDEX_FETCH_LIMIT = 1000;

function compactTradingDay(value: string): string {
  return value.replace(/\D/g, '').slice(0, 8);
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

/**
 * 基于硬编码的节假日数据，生成覆盖过去 3 年到当前日期（含未来约 30 天）的交易日序列。
 * 不再依赖上证指数 K 线数据。
 */
export function loadTradingCalendar(_store?: DataStore): Promise<string[]> {
  const now = shanghaiClock(new Date());
  const earliest = shanghaiIndexHistoryStartThreshold();
  // 往后多生成 30 天，避免跨年/月底时日历不够用
  const endParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.now() + 30 * 86_400_000));
  const get = (type: Intl.DateTimeFormatPartTypes) => endParts.find((item) => item.type === type)?.value ?? '';
  const endDate = `${get('year')}${get('month')}${get('day')}`;

  const calendar = buildTradingCalendar(earliest, endDate);
  return Promise.resolve(calendar);
}

/**
 * 基于节假日数据刷新交易日历（不再依赖上证指数 K 线）。
 * 自动化交易运行期间定期调用，与旧版 refreshShanghaiIndexTradingCalendar 签名兼容。
 */
export function refreshTradingCalendar(_store?: DataStore): Promise<{
  calendar: string[];
  inserted: number;
  latestDay: string;
  todayIncluded: boolean;
}> {
  const today = compactDate(new Date()).slice(0, 8);
  const calendar = buildTradingCalendar(
    shanghaiIndexHistoryStartThreshold(),
    today,
  );
  const latestDay = calendar.at(-1) ?? '';
  const todayIncluded = calendar.includes(today);
  console.log(`[market-date] 交易日历已刷新至 ${latestDay}（共 ${calendar.length} 个交易日，节假日数据源）`);
  return Promise.resolve({ calendar, inserted: 0, latestDay, todayIncluded });
}

/** @deprecated 请使用 refreshTradingCalendar */
export const refreshShanghaiIndexTradingCalendar = refreshTradingCalendar;

/** 在交易日历中取 <= ceiling 的最近一个交易日。 */
export function latestTradingDayOnOrBefore(calendar: string[], ceiling: string): string | null {
  const bound = compactTradingDay(ceiling);
  if (!bound) return calendar.at(-1) ? compactTradingDay(calendar.at(-1)!) : null;
  const eligible = calendar
    .map(compactTradingDay)
    .filter((day) => day && day <= bound);
  return eligible.at(-1) ?? null;
}

/**
 * 解析实际使用的交易日：基于节假日数据生成的交易日历，周末/节假日自动回退到最近交易日。
 * 若调用方显式指定了晚于本地日历的最新日期，则保留该日期。
 */
export async function resolveLatestTradingDate(_store: DataStore, asOf?: unknown): Promise<string> {
  const today = compactDate(new Date()).slice(0, 8);
  const explicit = compactTradingDay(String(asOf ?? ''));
  const hasExplicit = /^\d{8}$/.test(explicit);
  const ceiling = hasExplicit ? explicit : today;
  const calendar = await loadTradingCalendar();
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

  console.log(`[market-date] 无交易日历，回退到 ${ceiling}`);
  return ceiling;
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