import type {
  SectorCandle,
  SectorEntryLevel,
  SectorMomentumTag,
  SectorRotationResponse,
  SectorRotationSector,
} from '../src/types.js';

export interface BlockPricePoint {
  block_code: string;
  block_name: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * 同花顺板块代码段：881xxx = 行业板块，885xxx / 886xxx = 概念 / 风格概念。
 * 默认只对比行业板块；按「近 30 日涨停板块」为基准时改用概念板块（涨停原因多为概念）。
 */
export const INDUSTRY_BLOCK_PREFIX = '881';
export const CONCEPT_BLOCK_PREFIXES = ['885', '886'] as const;

/** 近两月按 40 个交易日计（约两个月）。 */
export const RECENT_TWO_MONTH_BARS = 40;
/** 近一周蜡烛根数。 */
export const RECENT_WEEK_BARS = 5;
/** 涨停基准：回看最近多少个交易日。 */
export const RECENT_LIMIT_UP_DAYS = 30;
/** 今年涨跌幅绝对值低于该值时比值失真，标记为「基数过小」。 */
export const MOMENTUM_MIN_YTD_PCT = 1;

export function isIndustryBlockCode(code: string | null | undefined): boolean {
  return String(code ?? '').trim().startsWith(INDUSTRY_BLOCK_PREFIX);
}

export function isConceptBlockCode(code: string | null | undefined): boolean {
  const prefix = String(code ?? '').trim().slice(0, 3);
  return CONCEPT_BLOCK_PREFIXES.some((item) => prefix === item);
}

function fixed(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 以第 end 根收盘价结尾、长度为 window 的 SMA；不足 window 根返回 null。 */
function sma(closes: number[], window: number, end = closes.length): number | null {
  if (end < window) return null;
  return average(closes.slice(end - window, end));
}

/**
 * 资金关注度标记：先看大方向（今年涨跌），再看比值 ratio = 近两月涨跌幅 / 今年涨跌幅。
 *
 * 今年上涨（大方向向上）：
 *   ratio ≥ 1        → 资金正关注（近两月贡献超过全年涨幅）
 *   0 ≤ ratio < 1    → 稳定（延续但节奏温和）
 *   -1 < ratio < 0   → 交易平稳（小幅回踩/走平）
 *   ratio ≤ -1       → 反转发生中（近两月逆势幅度已超过全年）
 *
 * 今年下跌（大方向向下）：
 *   0 ≤ ratio < 1    → 阴跌（延续下跌且节奏温和）
 *   ratio ≥ 1        → 加速下跌（近两月跌幅超过全年，资金出逃）
 *   -1 < ratio < 0   → 交易平稳（小幅反弹/走平）
 *   ratio ≤ -1       → 反转发生中（反弹幅度已超过全年跌幅）
 */
export function momentumTagOf(
  ratio: number | null,
  recentChangePct: number | null,
  changePct: number,
): SectorMomentumTag {
  if (recentChangePct == null) return '数据不足';
  if (Math.abs(changePct) < MOMENTUM_MIN_YTD_PCT) return '基数过小';
  if (ratio == null) return '数据不足';
  const declining = changePct < 0;
  if (ratio >= 1) return declining ? '加速下跌' : '资金正关注';
  if (ratio >= 0) return declining ? '阴跌' : '稳定';
  if (ratio > -1) return '交易平稳';
  return '反转发生中';
}

const TAG_POINTS: Record<SectorMomentumTag, number> = {
  资金正关注: 25,
  稳定: 22,
  交易平稳: 15,
  阴跌: 8,
  加速下跌: 3,
  反转发生中: 3,
  基数过小: 15,
  数据不足: 10,
};

export function entryLevelOf(score: number): SectorEntryLevel {
  if (score >= 75) return '平稳介入';
  if (score >= 60) return '可关注';
  if (score >= 45) return '观察';
  return '回避';
}

/**
 * 平稳介入评分（0-100），五项各 25 / 25 / 20 / 15 / 15：
 *   1. 大方向：今年涨跌幅（越大越好）
 *   2. 资金关注度：近两月/今年比值标记
 *   3. 均线排列：收盘 > MA3 > MA5 > MA10 最强，其次收盘 > MA5 > MA10
 *   4. MA5 斜率：相对 3 根前抬升 ≥0.5% 为强
 *   5. 平稳度：近一周平均振幅 ≤2% 为稳
 */
export function scoreSectorEntry(input: {
  changePct: number;
  tag: SectorMomentumTag;
  close: number | null;
  ma3: number | null;
  ma5: number | null;
  ma10: number | null;
  ma5SlopePct: number | null;
  avgAmplitudePct: number | null;
}): number {
  const { changePct, tag, close, ma3, ma5, ma10, ma5SlopePct, avgAmplitudePct } = input;
  const trendPoints = changePct >= 10 ? 25 : changePct > 0 ? 20 : changePct >= -10 ? 10 : 0;

  let alignmentPoints = 0;
  if (close != null && ma5 != null) {
    if (ma3 != null && ma10 != null && close > ma3 && ma3 > ma5 && ma5 > ma10) alignmentPoints = 20;
    else if (ma10 != null && close > ma5 && ma5 > ma10) alignmentPoints = 14;
    else if (ma10 != null && close > ma10) alignmentPoints = 8;
    else if (close > ma5) alignmentPoints = 6;
  }

  const slopePoints = ma5SlopePct == null ? 0 : ma5SlopePct >= 0.5 ? 15 : ma5SlopePct > -0.5 ? 8 : 0;
  const stabilityPoints = avgAmplitudePct == null
    ? 0
    : avgAmplitudePct <= 2 ? 15 : avgAmplitudePct <= 3.5 ? 10 : avgAmplitudePct <= 5 ? 5 : 0;

  return Math.round(trendPoints + TAG_POINTS[tag] + alignmentPoints + slopePoints + stabilityPoints);
}

/**
 * 把 block_daily_price 的日线收盘价聚合成「年初至今涨跌幅」曲线，并给出资金关注度标记与平稳介入评分。
 *
 * - 未指定 codes 时只取行业板块（881xxx）；指定 codes 时以该集合为基准（如「近 30 日涨停概念板块」）；
 * - 基准：该板块今年第一根有效收盘价；
 * - series 按全市场交易日对齐，缺失日为 null（图上断线，不做插值）；
 * - 只保留今年至少有两个交易日的板块，避免单点板块污染对比。
 */
export function buildSectorRotation(rows: BlockPricePoint[], year: number, codes?: ReadonlySet<string>): SectorRotationResponse {
  const universeRows = codes
    ? rows.filter((row) => codes.has(String(row.block_code ?? '').trim()))
    : rows.filter((row) => isIndustryBlockCode(row.block_code));
  const byCode = new Map<string, { name: string; points: BlockPricePoint[] }>();
  for (const row of universeRows) {
    const code = String(row.block_code ?? '').trim();
    const date = String(row.date ?? '').trim();
    const close = Number(row.close);
    if (!code || !date || !Number.isFinite(close) || close <= 0) continue;
    const entry = byCode.get(code) ?? { name: row.block_name || code, points: [] };
    entry.points.push({
      block_code: code,
      block_name: entry.name,
      date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close,
    });
    byCode.set(code, entry);
  }

  const dates = [...new Set(universeRows.map((row) => String(row.date ?? '').trim()).filter(Boolean))].sort();
  const sectors: SectorRotationSector[] = [];
  for (const [code, entry] of byCode) {
    const points = entry.points.sort((left, right) => left.date.localeCompare(right.date));
    if (points.length < 2) continue;
    const base = points[0].close;
    const byDate = new Map(points.map((point) => [point.date, point.close]));
    const series = dates.map((date) => {
      const close = byDate.get(date);
      return close == null ? null : fixed((close / base - 1) * 100);
    });
    const last = points[points.length - 1].close;
    const changePct = fixed((last / base - 1) * 100);

    // 近两月：最后一根往前数第 40 根收盘价作为基准
    const recentBase = points.length > RECENT_TWO_MONTH_BARS
      ? points[points.length - 1 - RECENT_TWO_MONTH_BARS].close
      : null;
    const recentChangePct = recentBase == null ? null : fixed((last / recentBase - 1) * 100);
    const momentumRatio = recentChangePct == null || Math.abs(changePct) < MOMENTUM_MIN_YTD_PCT
      ? null
      : fixed(recentChangePct / changePct, 3);
    const tag = momentumTagOf(momentumRatio, recentChangePct, changePct);

    // 均线
    const closes = points.map((point) => point.close);
    const ma3 = sma(closes, 3);
    const ma5 = sma(closes, 5);
    const ma10 = sma(closes, 10);
    const ma20 = sma(closes, 20);
    const ma5Prev = sma(closes, 5, Math.max(0, closes.length - 3));
    const ma5SlopePct = ma5 == null || ma5Prev == null || ma5Prev === 0
      ? null
      : fixed(((ma5 - ma5Prev) / ma5Prev) * 100, 3);

    // 近一周蜡烛（带当日 MA5 / MA10，方便前端叠加均线）
    const weekPoints = points.slice(-RECENT_WEEK_BARS);
    const weekStartIndex = points.length - weekPoints.length;
    const candles: SectorCandle[] = weekPoints.map((point, index) => {
      const end = weekStartIndex + index + 1;
      return {
        date: point.date,
        open: Number.isFinite(point.open) && point.open > 0 ? point.open : point.close,
        high: Number.isFinite(point.high) && point.high > 0 ? point.high : point.close,
        low: Number.isFinite(point.low) && point.low > 0 ? point.low : point.close,
        close: point.close,
        ma5: sma(closes, 5, end),
        ma10: sma(closes, 10, end),
      };
    });

    // 平稳度：近一周平均振幅（(高-低)/收盘）
    const amplitudes = candles.map((candle) => ((candle.high - candle.low) / candle.close) * 100);
    const avgAmplitudePct = amplitudes.length ? fixed(average(amplitudes), 3) : null;

    const entryScore = scoreSectorEntry({
      changePct,
      tag,
      close: last,
      ma3,
      ma5,
      ma10,
      ma5SlopePct,
      avgAmplitudePct,
    });

    sectors.push({
      code,
      name: entry.name,
      changePct,
      series,
      recentChangePct,
      momentumRatio,
      tag,
      candles,
      ma3: ma3 == null ? null : fixed(ma3, 3),
      ma5: ma5 == null ? null : fixed(ma5, 3),
      ma10: ma10 == null ? null : fixed(ma10, 3),
      ma20: ma20 == null ? null : fixed(ma20, 3),
      entryScore,
      entryLevel: entryLevelOf(entryScore),
    });
  }

  sectors.sort((left, right) => right.changePct - left.changePct);
  return { year, dates, sectors };
}
