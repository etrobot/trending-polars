import type { RankingRow } from '../src/types.js';
import { NOOP_AUDIT_LOGGER, type AuditLoggerLike } from './audit-log.js';
import { formatDateTime, round } from './format.js';

export type HistoricalBar = [
  date: string,
  open: number,
  close: number,
  high: number,
  low: number,
  volume: number,
  amount: number,
  changePct: number,
];

export interface HistoricalStockSeries {
  stock_code: string;
  stock_name: string;
  bars: HistoricalBar[];
}

export interface HistoricalIndexSeries {
  symbol: string;
  index_name: string;
  bars: HistoricalBar[];
}

export interface HistoricalLimitUpRecord {
  date: string;
  stock_code: string;
}

export interface HistoricalMarketData {
  schema_version: 1;
  source: 'eastmoney-unadjusted' | 'multi-source-qfq';
  generated_at: string;
  as_of_date: string;
  universe_as_of_date: string;
  requested_days: number;
  warmup_days: number;
  calendar: string[];
  stocks: HistoricalStockSeries[];
  indices?: HistoricalIndexSeries[];
  /** 同花顺 block_top 的权威涨停事实；不得从日涨幅反推。 */
  limit_up_records?: HistoricalLimitUpRecord[];
  failed_stocks: number;
}

export interface KLineData {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 成交量。腾讯的“手”会转换成股；新浪和东方财富保持接口原始成交量单位。 */
  volume: number;
  /** 成交额；数据源未提供时为 0。 */
  amount: number;
  changeRate?: number;
}

export type MarketKlineSource = 'tencent' | 'sina' | 'eastmoney' | 'none';
export type BlockKlineSource = 'ths-block' | 'none';
export type BlockKlinePeriod = '01' | '11' | '21';

export const BLOCK_KLINE_URL = 'https://d.10jqka.com.cn/v4/line/bk_{code}/{period}/last.js';

interface CollectionOptions {
  days: number;
  asOfDate: string;
  concurrency?: number;
  progress?: (completed: number, total: number, message: string) => void;
  cancelled?: () => boolean;
  audit?: AuditLoggerLike;
  traceId?: string;
}

const WARMUP_DAYS = 70;

function compactDate(value: string): string {
  return value.replaceAll('-', '').slice(0, 8);
}

function secIdForStock(code: string): string {
  return `${code.startsWith('6') ? 1 : 0}.${code}`;
}

function finiteNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseEastmoneyKlines(lines: string[] | undefined): HistoricalBar[] {
  if (!lines?.length) return [];
  const bars: HistoricalBar[] = [];
  for (const line of lines) {
    const fields = line.split(',');
    const open = finiteNumber(fields[1] ?? '');
    const close = finiteNumber(fields[2] ?? '');
    const high = finiteNumber(fields[3] ?? '');
    const low = finiteNumber(fields[4] ?? '');
    const volume = finiteNumber(fields[5] ?? '');
    const amount = finiteNumber(fields[6] ?? '');
    const changePct = finiteNumber(fields[8] ?? '');
    if (open == null || close == null || high == null || low == null || volume == null || amount == null || changePct == null) continue;
    if (open <= 0 || close <= 0 || high <= 0 || low <= 0) continue;
    bars.push([
      compactDate(fields[0] ?? ''),
      round(open, 3),
      round(close, 3),
      round(high, 3),
      round(low, 3),
      volume,
      round(amount, 2),
      round(changePct, 2),
    ]);
  }
  return bars.sort((left, right) => left[0].localeCompare(right[0]));
}

function marketForCode(code: string): 'SH' | 'SZ' {
  return /^(6|68|5|9)/.test(code) ? 'SH' : 'SZ';
}

function normalizedSymbol(symbol: string): { code: string; market: 'SH' | 'SZ'; full: string } | null {
  const normalized = symbol.trim().toLowerCase();
  const prefixed = normalized.match(/^(sh|sz)(\d{6})$/);
  const code = prefixed?.[2] ?? normalized.match(/^(\d{6})$/)?.[1];
  if (!code) return null;
  const market = (prefixed?.[1]?.toUpperCase() as 'SH' | 'SZ' | undefined) ?? marketForCode(code);
  return { code, market, full: `${market.toLowerCase()}${code}` };
}

export function parseTencentKlines(rows: unknown): KLineData[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const date = String(row[0] ?? '');
    const open = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    // 腾讯 qfqday 的第六列是成交量（手），转换成股；成交额接口未返回。
    const volume = Number(row[5]) * 100;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![open, close, high, low, volume].every(Number.isFinite) || open <= 0 || close <= 0) return [];
    return [{ date, open, close, high, low, volume, amount: 0 }];
  });
}

async function fetchFromTencent(symbol: { code: string; market: 'SH' | 'SZ'; full: string }, limit: number): Promise<KLineData[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=${symbol.full},day,,,${limit},qfq&r=${Math.random().toString().slice(2, 18)}`;
  try {
    const response = await fetch(url, {
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const text = await response.text();
    const prefix = text.match(/^kline_dayqfq\s*=\s*/)?.[0];
    if (!prefix) return [];
    const payload = JSON.parse(text.slice(prefix.length)) as {
      code?: number;
      data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] }>;
    };
    if (payload.code !== 0) return [];
    const rows = payload.data?.[symbol.full];
    return parseTencentKlines(rows?.qfqday ?? rows?.day).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

export function parseEastmoneyAdjustedKlines(lines: string[] | undefined): KLineData[] {
  if (!lines?.length) return [];
  return lines.flatMap((line) => {
    const fields = line.split(',');
    const date = fields[0] ?? '';
    const open = Number(fields[1]);
    const close = Number(fields[2]);
    const high = Number(fields[3]);
    const low = Number(fields[4]);
    const volume = Number(fields[5]);
    const amount = Number(fields[6]);
    const changeRate = Number(fields[8]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    if (![open, close, high, low, volume, amount].every(Number.isFinite)) return [];
    if (open <= 0 || close <= 0 || high <= 0 || low <= 0) return [];
    return [{
      date,
      open,
      close,
      high,
      low,
      volume,
      amount,
      changeRate: Number.isFinite(changeRate) ? changeRate : undefined,
    }];
  }).sort((left, right) => left.date.localeCompare(right.date));
}

async function fetchFromEastmoneyAdjusted(symbol: { code: string; market: 'SH' | 'SZ' }, limit: number): Promise<KLineData[]> {
  const params = new URLSearchParams({
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f116',
    ut: '7eea3edcaed734bea9cbfc24409ed989',
    klt: '101',
    fqt: '1',
    secid: `${symbol.market === 'SH' ? '1' : '0'}.${symbol.code}`,
    beg: '19700101',
    end: '20500101',
    // 东方财富在 beg/end 都给出时可能忽略 lmt，最终仍在本地截取最近 limit 条。
    lmt: String(limit),
  });
  try {
    const response = await fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, {
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    const payload = await response.json() as { data?: { klines?: string[] } | null };
    return parseEastmoneyAdjustedKlines(payload.data?.klines).slice(-limit);
  } catch {
    return [];
  }
}

interface SinaQfqFactor { d: string; f: string }

async function fetchSinaQfqFactors(symbol: { full: string }): Promise<Map<string, number>> {
  const factors = new Map<string, number>();
  try {
    const response = await fetch(`https://finance.sina.com.cn/realstock/company/${symbol.full}/qfq.js`, {
      headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return factors;
    const text = await response.text();
    const match = text.match(/=\s*(\{.*?\})\s*;/);
    const data = match?.[1] ? (JSON.parse(match[1]) as { data?: SinaQfqFactor[] }).data : undefined;
    for (const item of data ?? []) factors.set(item.d, Number(item.f));
  } catch {
    // The Sina endpoint is only a fallback; an unavailable factor endpoint must not abort the chain.
  }
  return factors;
}

export function parseSinaKlines(
  rows: Array<{ day?: string; date?: string; open?: string; close?: string; high?: string; low?: string; volume?: string }> | undefined,
  factors: Map<string, number> = new Map(),
  limit = 120,
): KLineData[] {
  if (!Array.isArray(rows)) return [];
  const sortedFactors = [...factors.entries()]
    .filter(([, factor]) => Number.isFinite(factor) && factor > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const factorFor = (date: string) => {
    let result = 1;
    for (const [factorDate, factor] of sortedFactors) {
      if (factorDate > date) break;
      result = factor;
    }
    return result;
  };
  return rows.flatMap((item) => {
    const date = item.day ?? item.date ?? '';
    const factor = factorFor(date) || 1;
    const open = Number(item.open) / factor;
    const close = Number(item.close) / factor;
    const high = Number(item.high) / factor;
    const low = Number(item.low) / factor;
    // 复权只作用于价格，成交量不能除以前复权因子。
    const volume = Number(item.volume);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    if (![open, close, high, low, volume].every(Number.isFinite) || open <= 0 || close <= 0 || high <= 0 || low <= 0) return [];
    return [{ date, open, close, high, low, volume, amount: 0 }];
  }).sort((left, right) => left.date.localeCompare(right.date)).slice(-Math.max(1, Math.trunc(limit)));
}

async function fetchFromSina(symbol: { full: string }, limit: number): Promise<KLineData[]> {
  try {
    const [response, factors] = await Promise.all([
      fetch(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol.full}&scale=240&ma=no&datalen=${limit}`, {
        headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(5_000),
      }),
      fetchSinaQfqFactors(symbol),
    ]);
    if (!response.ok) return [];
    const payload = await response.json() as Array<{ day?: string; date?: string; open?: string; close?: string; high?: string; low?: string; volume?: string }>;
    return parseSinaKlines(payload, factors, limit);
  } catch {
    return [];
  }
}

export async function fetchAdjustedKlines(symbol: string, limit = 120): Promise<{ klines: KLineData[]; source: MarketKlineSource }> {
  const normalized = normalizedSymbol(symbol);
  if (!normalized) return { klines: [], source: 'none' };
  const boundedLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
  const sources: Array<[MarketKlineSource, () => Promise<KLineData[]>]> = [
    ['tencent', () => fetchFromTencent(normalized, boundedLimit)],
    ['sina', () => fetchFromSina(normalized, boundedLimit)],
    ['eastmoney', () => fetchFromEastmoneyAdjusted(normalized, boundedLimit)],
  ];
  for (const [source, fetcher] of sources) {
    const klines = await fetcher();
    if (klines.length > 0) {
      for (let index = 0; index < klines.length; index += 1) {
        if (klines[index].changeRate === undefined && index > 0 && klines[index - 1].close > 0) {
          klines[index].changeRate = round((klines[index].close - klines[index - 1].close) / klines[index - 1].close * 100, 2);
        }
      }
      return { klines: klines.slice(-boundedLimit), source };
    }
  }
  return { klines: [], source: 'none' };
}

function normalizeBlockDate(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return value;
}

function normalizeBlockCode(code: string): string | null {
  const normalized = code.trim().toLowerCase().replace(/^bk[_-]?/, '');
  return /^\d{6}$/.test(normalized) ? normalized : null;
}

/** 解析同花顺板块指数 v4 JSONP 日线。 */
export function parseBlockKlines(payload: string | Record<string, unknown>, limit = 120): KLineData[] {
  let body: Record<string, unknown> | null = null;
  try {
    if (typeof payload === 'string') {
      const start = payload.indexOf('(');
      const end = payload.lastIndexOf(')');
      const json = start >= 0 && end > start ? payload.slice(start + 1, end) : payload;
      body = JSON.parse(json) as Record<string, unknown>;
    } else {
      body = payload;
    }
  } catch {
    return [];
  }
  const raw = body?.data;
  const lines = Array.isArray(raw)
    ? raw.map((item) => String(item))
    : typeof raw === 'string'
      ? raw.split(';')
      : [];
  const bars: KLineData[] = lines.flatMap((line): KLineData[] => {
    const fields = line.split(',');
    if (fields.length < 7) return [];
    const date = normalizeBlockDate(fields[0] ?? '');
    // 同花顺字段：日期、开盘、最高、最低、收盘、成交量、成交额……
    const open = Number(fields[1]);
    const high = Number(fields[2]);
    const low = Number(fields[3]);
    const close = Number(fields[4]);
    const volume = Number(fields[5]);
    const amount = Number(fields[6]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    if (![open, high, low, close, volume, amount].every(Number.isFinite)) return [];
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return [];
    return [{ date, open, close, high, low, volume, amount }];
  }).sort((left, right) => left.date.localeCompare(right.date));
  for (let index = 0; index < bars.length; index += 1) {
    if (index > 0 && bars[index - 1].close > 0) {
      bars[index].changeRate = round((bars[index].close - bars[index - 1].close) / bars[index - 1].close * 100, 2);
    } else {
      bars[index].changeRate = 0;
    }
  }
  return bars.slice(-Math.max(1, Math.trunc(limit)));
}

export async function fetchBlockKlines(
  code: string,
  period: BlockKlinePeriod = '01',
  limit = 120,
): Promise<{ klines: KLineData[]; source: BlockKlineSource; name?: string }> {
  const normalizedCode = normalizeBlockCode(code);
  if (!normalizedCode || !['01', '11', '21'].includes(period)) return { klines: [], source: 'none' };
  const boundedLimit = Math.min(1000, Math.max(1, Math.trunc(limit)));
  const url = BLOCK_KLINE_URL
    .replace('{code}', normalizedCode)
    .replace('{period}', period);
  try {
    const response = await fetch(url, {
      headers: {
        Referer: 'https://www.10jqka.com.cn/',
        'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { klines: [], source: 'none' };
    const text = await response.text();
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    const json = start >= 0 && end > start ? text.slice(start + 1, end) : '';
    const body = json ? JSON.parse(json) as Record<string, unknown> : null;
    const klines = parseBlockKlines(body ?? text, boundedLimit);
    return {
      klines,
      source: klines.length ? 'ths-block' : 'none',
      name: typeof body?.name === 'string' ? body.name : undefined,
    };
  } catch {
    return { klines: [], source: 'none' };
  }
}

// 明确别名，避免调用方把板块指数误接到个股/中证指数的多源接口。
export const parseThsBlockKlines = parseBlockKlines;
export const fetchThsBlockKlines = fetchBlockKlines;

export type BlockTopSource = 'ths-limit-up' | 'none';

export interface BlockTopStock {
  code: string;
  name: string;
  continue_num: number;
  reason_type: string;
  change_rate: number | null;
  latest: number | null;
  is_st: boolean;
}

export interface BlockTopData {
  code: string;
  name: string;
  change: number;
  limit_up_num: number;
  continuous_plate_num: number;
  stock_list: BlockTopStock[];
}

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intFrom(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/**
 * 解析同花顺涨停板块排行（dataapi/limit_up/block_top）。字段名做兼容映射，
 * 缺字段/异常结构一律跳过而不抛错，与其它数据源解析器保持一致。
 */
export function parseBlockTop(payload: string | Record<string, unknown>): BlockTopData[] {
  let body: Record<string, unknown> | null = null;
  try {
    body = typeof payload === 'string' ? JSON.parse(payload) as Record<string, unknown> : payload;
  } catch {
    return [];
  }
  const rows = body?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw): BlockTopData[] => {
    if (!raw || typeof raw !== 'object') return [];
    const block = raw as Record<string, unknown>;
    const code = String(block.code ?? block.block_code ?? '').trim();
    const name = String(block.name ?? block.block_name ?? '').trim();
    if (!code || !name) return [];
    const stockRows = Array.isArray(block.stock_list)
      ? block.stock_list
      : Array.isArray(block.stocks) ? block.stocks : [];
    const stockList = stockRows.flatMap((item): BlockTopStock[] => {
      if (!item || typeof item !== 'object') return [];
      const stock = item as Record<string, unknown>;
      const stockCode = String(stock.code ?? '').trim();
      if (!/^\d{6}$/.test(stockCode)) return [];
      return [{
        code: stockCode,
        name: String(stock.name ?? '').trim(),
        continue_num: Math.max(1, intFrom(stock.continue_num ?? stock.continuous_num, 1)),
        reason_type: String(stock.reason_type ?? '').trim(),
        change_rate: finiteOrNull(stock.change_rate),
        latest: finiteOrNull(stock.latest),
        is_st: stock.is_st === 1 || stock.is_st === true || String(stock.is_st) === '1',
      }];
    });
    return [{
      code,
      name,
      change: finiteOrNull(block.change) ?? 0,
      limit_up_num: intFrom(block.limit_up_num, stockList.length),
      continuous_plate_num: intFrom(block.continuous_plate_num ?? block.max_continue, 0),
      stock_list: stockList,
    }];
  });
}

/**
 * 采集同花顺涨停板块排行。网络失败/被反爬拦截时优雅返回空数组（source='none'），
 * 由调用方回退到预生成的 analysis.json。
 */
export async function fetchBlockTop(date?: string): Promise<{ blocks: BlockTopData[]; source: BlockTopSource }> {
  const params = new URLSearchParams({ filter: 'HS,GEM2STAR' });
  if (date) {
    const normalized = compactDate(date);
    if (/^\d{8}$/.test(normalized)) params.set('date', normalized);
  }
  try {
    const response = await fetch(`https://data.10jqka.com.cn/dataapi/limit_up/block_top?${params}`, {
      headers: {
        Referer: 'https://data.10jqka.com.cn/',
        'User-Agent': 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { blocks: [], source: 'none' };
    const blocks = parseBlockTop(await response.text());
    return { blocks, source: blocks.length ? 'ths-limit-up' : 'none' };
  } catch {
    return { blocks: [], source: 'none' };
  }
}

async function fetchKlines(secId: string, limit: number, endDate: string): Promise<HistoricalBar[]> {
  const symbol = secId.startsWith('1.') ? `sh${secId.slice(2)}` : `sz${secId.slice(2)}`;
  const result = await fetchAdjustedKlines(symbol, limit);
  const filtered = result.klines
    .filter((kline) => compactDate(kline.date) <= endDate)
    .map((kline, index, rows): HistoricalBar => [
      compactDate(kline.date),
      round(kline.open, 3),
      round(kline.close, 3),
      round(kline.high, 3),
      round(kline.low, 3),
      kline.volume,
      kline.amount,
      round(kline.changeRate ?? (index > 0 && rows[index - 1].close > 0 ? (kline.close - rows[index - 1].close) / rows[index - 1].close * 100 : 0), 2),
    ]);
  return filtered;
}

function uniqueUniverse(rankings: RankingRow[]): RankingRow[] {
  const byCode = new Map<string, RankingRow>();
  for (const row of rankings) {
    const code = String(row.stock_code ?? '').trim();
    if (!/^\d{6}$/.test(code)) continue;
    if (!byCode.has(code)) byCode.set(code, row);
  }
  return [...byCode.values()];
}

export async function collectHistoricalMarketData(
  rankings: RankingRow[],
  options: CollectionOptions,
): Promise<HistoricalMarketData | null> {
  const audit = options.audit ?? NOOP_AUDIT_LOGGER;
  const collectionStarted = Date.now();
  const universe = uniqueUniverse(rankings);
  if (!universe.length) throw new Error('当前股票池为空，无法采集历史行情');

  const requestedDays = Math.min(60, Math.max(5, Math.trunc(options.days)));
  const limit = requestedDays + WARMUP_DAYS + 5;
  const endDate = compactDate(options.asOfDate);
  await audit.info('market_data', 'collection_started', {
    traceId: options.traceId,
    data: { source: 'multi-source-qfq', end_date: endDate, requested_days: requestedDays, universe_size: universe.length },
  });
  let calendarBars: HistoricalBar[];
  try {
    calendarBars = await fetchKlines('1.000001', limit, endDate);
  } catch (error) {
    await audit.error('market_data', 'calendar_fetch_failed', {
      traceId: options.traceId,
      durationMs: Date.now() - collectionStarted,
      data: { end_date: endDate, limit },
      error,
    });
    throw error;
  }
  const calendar = calendarBars.map((bar) => bar[0]).filter((date) => date <= endDate);
  await audit.info('market_data', 'calendar_loaded', {
    traceId: options.traceId,
    data: { calendar_days: calendar.length, first_date: calendar[0], last_date: calendar.at(-1) },
  });
  if (calendar.length < requestedDays + 1) {
    await audit.error('market_data', 'calendar_insufficient', {
      traceId: options.traceId,
      data: { required_days: requestedDays + 1, actual_days: calendar.length, end_date: endDate },
    });
    throw new Error(`历史交易日不足：需要至少 ${requestedDays + 1} 天，实际 ${calendar.length} 天`);
  }

  const stocks: HistoricalStockSeries[] = [];
  let failedStocks = 0;
  let cursor = 0;
  let completed = 0;
  const concurrency = Math.min(24, Math.max(2, options.concurrency ?? 12));

  const worker = async () => {
    while (true) {
      if (options.cancelled?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= universe.length) return;
      const row = universe[index];
      const stockStarted = Date.now();
      try {
        let bars: HistoricalBar[];
        try {
          bars = (await fetchKlines(secIdForStock(row.stock_code), limit, endDate))
            .filter((bar) => bar[0] <= endDate);
        } catch (error) {
          failedStocks += 1;
          await audit.error('market_data', 'stock_fetch_failed', {
            traceId: options.traceId,
            durationMs: Date.now() - stockStarted,
            data: { stock_code: row.stock_code, stock_name: row.stock_name },
            error,
          });
          continue;
        }
        if (bars.length >= 20) {
          stocks.push({ stock_code: row.stock_code, stock_name: row.stock_name, bars });
          await audit.debug('market_data', 'stock_loaded', {
            traceId: options.traceId,
            durationMs: Date.now() - stockStarted,
            data: {
              stock_code: row.stock_code,
              stock_name: row.stock_name,
              bars: bars.length,
              first_date: bars[0]?.[0],
              last_date: bars.at(-1)?.[0],
              last_bar: bars.at(-1),
            },
          });
        } else {
          failedStocks += 1;
          await audit.warn('market_data', 'stock_insufficient_history', {
            traceId: options.traceId,
            durationMs: Date.now() - stockStarted,
            data: { stock_code: row.stock_code, stock_name: row.stock_name, bars: bars.length },
          });
        }
      } finally {
        completed += 1;
        if (completed === universe.length || completed % 20 === 0) {
          options.progress?.(completed, universe.length, `采集真实历史日线 ${completed}/${universe.length}`);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, universe.length) }, () => worker()));
  if (options.cancelled?.()) {
    await audit.warn('market_data', 'collection_cancelled', {
      traceId: options.traceId,
      durationMs: Date.now() - collectionStarted,
      data: { completed, universe_size: universe.length, loaded_stocks: stocks.length, failed_stocks: failedStocks },
    });
    return null;
  }

  const minimumCoverage = Math.min(20, Math.max(2, Math.floor(universe.length * 0.2)));
  if (stocks.length < minimumCoverage) {
    await audit.error('market_data', 'collection_coverage_failed', {
      traceId: options.traceId,
      durationMs: Date.now() - collectionStarted,
      data: { loaded_stocks: stocks.length, universe_size: universe.length, minimum_coverage: minimumCoverage, failed_stocks: failedStocks },
    });
    throw new Error(`历史行情覆盖不足：成功 ${stocks.length}/${universe.length}，请稍后重试`);
  }

  const result: HistoricalMarketData = {
    schema_version: 1,
    source: 'multi-source-qfq',
    generated_at: formatDateTime(),
    as_of_date: calendar.at(-1) ?? endDate,
    universe_as_of_date: endDate,
    requested_days: requestedDays,
    warmup_days: WARMUP_DAYS,
    calendar,
    stocks: stocks.sort((left, right) => left.stock_code.localeCompare(right.stock_code)),
    indices: [{ symbol: 'sh000001', index_name: '上证指数', bars: calendarBars }],
    failed_stocks: failedStocks,
  };
  await audit.info('market_data', 'collection_completed', {
    traceId: options.traceId,
    durationMs: Date.now() - collectionStarted,
    data: {
      source: result.source,
      as_of_date: result.as_of_date,
      calendar_days: result.calendar.length,
      loaded_stocks: result.stocks.length,
      failed_stocks: result.failed_stocks,
      requested_days: result.requested_days,
    },
  });
  return result;
}
