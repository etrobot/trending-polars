/**
 * 数据质量检查（P4）。
 *
 * 开跑前校验三件事，缺口**显式列出**而不是静默跳过：
 * 1. **标的行情连续性**：每只标的在回测区间内是否覆盖了全部交易日。
 * 2. **除权标记完整性**：行情是否已做前复权处理。未复权的数据在除权日会
 *    出现假跌停，回测结果不可信，必须当作缺口记录。
 * 3. **涨停记录覆盖率**：回测区间内有多少交易日缺少涨停事实（权威数据来自
 *    同花顺 block_top，不得从日涨幅反推）。
 *
 * 缺口比例超过阈值时判定为不可用，由流水线中止运行。
 */

import type { HistoricalMarketData } from '../historical-market.js';
import type { DataQualityGaps, DataQualityReport } from './types.js';

export interface QualityThresholds {
  /** 行情覆盖率低于该值即判定不可用。 */
  minPriceCoverage: number;
  /** 涨停记录覆盖率低于该值即判定不可用。 */
  minLimitUpCoverage: number;
  /** 是否要求行情已做前复权。 */
  requireAdjusted: boolean;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minPriceCoverage: 0.8,
  minLimitUpCoverage: 0.6,
  requireAdjusted: true,
};

function compactDate(value: string): string {
  return value.replaceAll('-', '').slice(0, 8);
}

/**
 * 计算数据质量报告。
 *
 * @param history 历史行情快照
 * @param universe 标的池（股票代码）
 * @param range 需要覆盖的交易日区间（含），YYYYMMDD
 * @param thresholds 阈值
 */
export function assessDataQuality(
  history: HistoricalMarketData,
  universe: readonly string[],
  range: { start: string; end: string },
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
): DataQualityReport {
  const reasons: string[] = [];
  const gaps: DataQualityGaps = { priceGaps: [], adjustmentIssues: [], limitUpMissingDates: [] };

  const asOfDate = compactDate(history.as_of_date);
  const calendar = [...new Set(history.calendar.map(compactDate).filter(Boolean))]
    .filter((date) => date >= range.start && date <= range.end)
    .sort();
  const universeCodes = [...new Set(universe.map((code) => String(code).trim()).filter(Boolean))];

  // ---- 1. 行情连续性 ----
  const seriesByCode = new Map(history.stocks.map((stock) => [stock.stock_code, stock]));
  let coveredStocks = 0;
  let requiredSlots = universeCodes.length * calendar.length;
  let coveredSlots = 0;
  for (const code of universeCodes) {
    const dates = new Set(
      (seriesByCode.get(code)?.bars ?? []).map((bar) => compactDate(bar[0])).filter(Boolean),
    );
    const missing = calendar.filter((date) => !dates.has(date));
    const present = calendar.length - missing.length;
    coveredSlots += present;
    if (present >= calendar.length && calendar.length > 0) {
      coveredStocks += 1;
    } else if (missing.length) {
      gaps.priceGaps.push({ stock_code: code, missing_dates: missing });
    }
  }
  const priceCoverageRatio = requiredSlots > 0 ? coveredSlots / requiredSlots : 0;

  // ---- 2. 除权标记完整性 ----
  const adjusted = history.source === 'multi-source-qfq';
  if (!adjusted) {
    gaps.adjustmentIssues.push(
      `行情数据源为 ${history.source}，未做前复权处理，除权日可能出现假跌停`,
    );
  }

  // ---- 3. 涨停记录覆盖率 ----
  const limitUpDates = new Set(
    (history.limit_up_records ?? []).map((record) => compactDate(record.date)).filter(Boolean),
  );
  const missingLimitUpDates = calendar.filter((date) => !limitUpDates.has(date));
  gaps.limitUpMissingDates = missingLimitUpDates;
  const limitUpCoverageRatio = calendar.length > 0
    ? (calendar.length - missingLimitUpDates.length) / calendar.length
    : 0;

  if (!calendar.length) {
    reasons.push(`交易日历在 ${range.start}~${range.end} 区间内为空`);
  }
  if (!universeCodes.length) {
    reasons.push('标的池为空');
  }
  if (priceCoverageRatio < thresholds.minPriceCoverage) {
    reasons.push(
      `行情连续性覆盖率 ${(priceCoverageRatio * 100).toFixed(1)}% 低于门槛 ${(thresholds.minPriceCoverage * 100).toFixed(1)}%`,
    );
  }
  if (thresholds.requireAdjusted && !adjusted) {
    reasons.push('行情未做前复权处理，无法保证回测口径正确');
  }
  if (limitUpCoverageRatio < thresholds.minLimitUpCoverage) {
    reasons.push(
      `涨停记录覆盖率 ${(limitUpCoverageRatio * 100).toFixed(1)}% 低于门槛 ${(thresholds.minLimitUpCoverage * 100).toFixed(1)}%`,
    );
  }

  return {
    ok: reasons.length === 0,
    asOfDate,
    universeSize: universeCodes.length,
    coveredStocks,
    priceCoverageRatio: Number(priceCoverageRatio.toFixed(4)),
    limitUpCoverageRatio: Number(limitUpCoverageRatio.toFixed(4)),
    adjusted,
    gaps,
    reasons,
  };
}
