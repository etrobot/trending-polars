import { round } from './format.js';

function compactDate(value: string): string {
  return value.replaceAll('-', '').slice(0, 8);
}

// ---------------------------------------------------------------------------
// 基准指数对照曲线：从搜狐获取指定指数日线，归一化到与回测相同的起始资金，
// 生成可叠加在回测净值曲线上的 benchmark 曲线。
// ---------------------------------------------------------------------------

export interface BenchmarkPoint {
  date: string;
  value: number;
}

/**
 * 搜狐 K 线数据行（JSONP dataBasic 中的一条）。
 * 字段顺序：日期、开盘、收盘、最高、最低、成交额、成交量、振幅、涨跌额、涨跌幅。
 */
export interface SohuKlineRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  amount: number;
  volume: number;
}

// 搜狐中文字段名 → 英文映射
const SOHU_FIELD_NAMES: Record<string, number> = {
  date: 0,
  open: 1,
  close: 2,
  high: 3,
  low: 4,
  amount: 5,
  volume: 6,
};

/**
 * 解析搜狐 JSONP 响应中的 K 线数据。
 * 响应格式：quote_d_dividend({status:0, dataBasic:[...]})
 */
export function parseSohuKlines(raw: string): SohuKlineRow[] {
  const match = raw.match(/quote_d_dividend\((.+)\)/);
  if (!match) return [];
  try {
    const body = JSON.parse(match[1]) as {
      status?: number;
      dataBasic?: Array<[string, string, string, string, string, string, string, string, string, string]>;
    };
    if (body.status !== 0 || !body.dataBasic?.length) return [];
    return body.dataBasic.map((row) => ({
      date: compactDate(row[0]),
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      amount: Number(row[5]),
      volume: Number(row[6]),
    })).filter((row) => row.date.length === 8 && row.close > 0 && row.open > 0);
  } catch {
    return [];
  }
}

/**
 * 从搜狐获取指定指数日线。
 * @param indexCode 指数代码，如 '000010'（上证380）
 * @param market 市场代码，如 '010'（沪深）
 * @param limit 获取条数
 */
export async function fetchSohuIndexKlines(
  indexCode = '000010',
  market = '010',
  _limit = 120,
): Promise<{ klines: SohuKlineRow[]; source: string }> {
  const url = `https://hq.stock.sohu.com/mkline/zs/${market}/zs_${indexCode}-10_2.html?_=${Date.now()}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: '*/*',
        referer: 'https://static.k.sohu.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) return { klines: [], source: 'none' };
    const text = await response.text();
    const klines = parseSohuKlines(text);
    return { klines, source: klines.length ? 'sohu-benchmark' : 'none' };
  } catch {
    return { klines: [], source: 'none' };
  }
}

/**
 * 将搜狐 K 线归一化为与回测相同起始资金的净值曲线。
 * @param klines 搜狐 K 线（已按日期升序排列）
 * @param equityDates 回测净值曲线的日期列表，用于对齐
 * @param initialCapital 起始资金（默认 100000）
 */
export function buildBenchmarkCurve(
  klines: SohuKlineRow[],
  equityDates: string[],
  initialCapital = 100_000,
): BenchmarkPoint[] {
  if (!klines.length || !equityDates.length) return [];

  // 按日期升序排列
  const sorted = [...klines].sort((a, b) => a.date.localeCompare(b.date));
  const dateSet = new Set(equityDates);

  // 找到第一个在 equityDates 范围内的日期作为基准点
  const firstEquityDate = equityDates[0];
  const firstIndex = sorted.findIndex((k) => k.date >= firstEquityDate);
  if (firstIndex < 0) return [];

  const baseClose = sorted[firstIndex].close;
  if (baseClose <= 0) return [];

  // 建立日期 → close 的快速查找
  const closeByDate = new Map(sorted.map((k) => [k.date, k.close]));

  const curve: BenchmarkPoint[] = [];
  let previousClose = baseClose;
  let previousValue = initialCapital;

  for (const date of equityDates) {
    const close = closeByDate.get(date);
    if (close != null && close > 0) {
      // 有实际指数数据：按指数涨跌幅计算净值
      const dailyReturn = (close - previousClose) / previousClose;
      previousValue = round(previousValue * (1 + dailyReturn), 2);
      previousClose = close;
    }
    // 如果当天没有指数数据（非交易日），保持上一日净值不变
    curve.push({ date, value: previousValue });
  }

  return curve;
}

/**
 * 获取基准指数对照曲线（一步完成：网络请求 → 解析 → 归一化）。
 * @param equityDates 回测净值曲线的日期列表
 * @param initialCapital 起始资金
 * @param indexCode 指数代码
 */
export async function fetchBenchmarkCurve(
  equityDates: string[],
  initialCapital = 100_000,
  indexCode = '000010',
): Promise<{ curve: BenchmarkPoint[]; name: string; source: string }> {
  const { klines, source } = await fetchSohuIndexKlines(indexCode);
  if (!klines.length) {
    return { curve: [], name: '', source };
  }
  const curve = buildBenchmarkCurve(klines, equityDates, initialCapital);
  const indexName = indexCode === '000001' ? '上证指数'
    : indexCode === '000010' ? '上证380'
    : indexCode === '000300' ? '沪深300'
    : indexCode === '000905' ? '中证500'
    : indexCode === '000688' ? '科创50'
    : indexCode === '399006' ? '创业板指'
    : `指数${indexCode}`;
  return { curve, name: indexName, source };
}