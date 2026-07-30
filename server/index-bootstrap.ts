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

// ── 模块级日历缓存 ──────────────────────────────────────
// 节假日数据硬编码且年内不变，一次生成即可覆盖全年；
// 仅在跨年或首次调用时重新计算，日常运行直接复用缓存。
let cachedCalendar: string[] | null = null;
/** 缓存覆盖到的最后日期（YYYYMMDD），用于判断缓存是否仍有效。 */
let cachedValidUntil = '';

/**
 * 获取或构建交易日历（带缓存）。
 * 首次调用生成从 3 年前到当年末 + 30 天的完整日历并缓存；
 * 后续调用若当天仍在缓存覆盖范围内，直接返回缓存，不再重算。
 */
function getOrBuildCalendar(): string[] {
  const today = compactDate(new Date()).slice(0, 8);

  // 缓存命中：今天仍在覆盖范围内
  if (cachedCalendar && cachedCalendar.length > 0 && today <= cachedValidUntil) {
    return cachedCalendar;
  }

  // 缓存未命中：重新生成到当年末 + 30 天
  const earliest = shanghaiIndexHistoryStartThreshold();
  const shanghaiNow = shanghaiClock(new Date());
  const currentYear = Number(shanghaiNow.date.slice(0, 4));
  // 当年末 + 30 天缓冲，确保跨年/月底时日历够用
  const bufferEnd = new Date(currentYear + 1, 0, 30); // 次年 1 月 30 日
  const endParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(bufferEnd);
  const get = (type: Intl.DateTimeFormatPartTypes) => endParts.find((item) => item.type === type)?.value ?? '';
  const endDate = `${get('year')}${get('month')}${get('day')}`;

  cachedCalendar = buildTradingCalendar(earliest, endDate);
  cachedValidUntil = endDate;
  return cachedCalendar;
}

/** 清除日历缓存（仅用于测试）。 */
export function clearCalendarCache(): void {
  cachedCalendar = null;
  cachedValidUntil = '';
}

/**
 * 基于硬编码的节假日数据，生成覆盖过去 3 年到当年末的交易日序列。
 * 结果已缓存，年内多次调用不会重复计算。
 */
export function loadTradingCalendar(_store?: DataStore): Promise<string[]> {
  return Promise.resolve(getOrBuildCalendar());
}

/**
 * 基于节假日数据刷新交易日历（不再依赖上证指数 K 线）。
 * 自动化交易运行期间定期调用，与旧版 refreshShanghaiIndexTradingCalendar 签名兼容。
 * 结果已缓存，年内多次调用直接复用，仅首次或跨年时打印日志。
 */
export function refreshTradingCalendar(_store?: DataStore): Promise<{
  calendar: string[];
  inserted: number;
  latestDay: string;
  todayIncluded: boolean;
}> {
  const today = compactDate(new Date()).slice(0, 8);
  const wasCached = cachedCalendar !== null && today <= cachedValidUntil;
  const calendar = getOrBuildCalendar();
  const latestDay = calendar.at(-1) ?? '';
  const todayIncluded = calendar.includes(today);
  // 仅在首次生成或跨年重新计算时打印，避免日常刷新刷屏
  if (!wasCached) {
    console.log(`[market-date] 交易日历已生成至 ${cachedValidUntil}（共 ${calendar.length} 个交易日，节假日数据源，年内缓存）`);
  }
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