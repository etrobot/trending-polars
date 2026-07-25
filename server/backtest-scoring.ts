import pl from 'nodejs-polars';
import type { RankingRow } from '../src/types.js';
import { round } from './format.js';
import type { HistoricalBlockSeries, HistoricalMarketData } from './historical-market.js';
import { classifyMarketState, volatilityTrendScore, type Bar, type TrendAxis, type VolatilityClass } from './scoring-engine.js';

// ---------------------------------------------------------------------------
// Vectorized backtest scoring: computes the full (stock × date) score matrix
// in a single Polars pass, replacing the per-day per-stock scoreStock loop.
// ---------------------------------------------------------------------------

/** Pre-compute trend_strength and limit_up flag per stock in one O(n) pass. */
function computeStockArrays(
  closes: Float64Array,
  dates: string[],
  limitUpDates: ReadonlySet<string> | undefined,
): { strength: Float64Array; limitUp: Float64Array } {
  const n = closes.length;
  const strength = new Float64Array(n);
  const limitUp = new Float64Array(n);
  const lookback = 20;
  const sumX = (lookback - 1) * lookback / 2;
  const sumX2 = (lookback - 1) * lookback * (2 * lookback - 1) / 6;

  for (let i = 0; i < n; i += 1) {
    // Limit-up flag
    if (limitUpDates?.has(dates[i])) limitUp[i] = 1;
    // Trend strength (rolling linear regression slope / mean)
    const start = Math.max(0, i - lookback + 1);
    const len = i - start + 1;
    if (len < 5) continue;
    let sy = 0;
    let sxy = 0;
    for (let j = start; j <= i; j += 1) {
      const x = j - start;
      sy += closes[j];
      sxy += x * closes[j];
    }
    const denom = len * sumX2 - sumX * sumX;
    if (!denom) continue;
    // For partial windows (len < 20), sumX/sumX2 differ from the full-window constants
    const actualSumX = (len - 1) * len / 2;
    const actualSumX2 = (len - 1) * len * (2 * len - 1) / 6;
    const actualDenom = len * actualSumX2 - actualSumX * actualSumX;
    if (!actualDenom) continue;
    const slope = (len * sxy - actualSumX * sy) / actualDenom;
    const mean = sy / len;
    strength[i] = mean > 0 ? slope / mean : 0;
  }
  return { strength, limitUp };
}

/**
 * Pre-compute rolling sector trend states for each date in the backtest range.
 * Returns Map<sector_code, Map<date, state_id>>.
 * Uses classifyMarketState on a sliding window of block bars (pure JS, few sectors).
 */
function computeSectorStates(
  blocks: HistoricalBlockSeries[],
  dates: string[],
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  const dateSet = new Set(dates);
  for (const block of blocks) {
    const bars: Bar[] = block.bars.map((b) => ({
      date: String(b[0]),
      open: b[1],
      close: b[2],
      high: b[3],
      low: b[4],
      volume: b[5],
      amount: b[6],
      changePct: b[7],
    }));
    // Build date → index lookup
    const indexByDate = new Map<string, number>();
    for (let i = 0; i < bars.length; i += 1) {
      const d = bars[i].date.replaceAll('-', '').slice(0, 8);
      indexByDate.set(d, i);
    }
    const stateMap = new Map<string, number>();
    for (const date of dates) {
      const endIdx = indexByDate.get(date);
      if (endIdx == null || endIdx < 19) continue;
      const window = bars.slice(0, endIdx + 1);
      const state = classifyMarketState(window);
      if (state.state_id >= 1 && state.state_id <= 8) {
        stateMap.set(date, state.state_id);
      }
    }
    if (stateMap.size) result.set(block.block_code, stateMap);
  }
  return result;
}

/**
 * Compute the full score matrix for all stocks × dates in one vectorized pass.
 * Returns a Map keyed by date, each value is the ranked list of scoring rows.
 */
export function computeBacktestScores(
  history: HistoricalMarketData,
  dates: string[],
  limitUpDatesByCode: Map<string, Set<string>>,
): Map<string, RankingRow[]> {
  const dateSet = new Set(dates);

  // ---- 0. Pre-compute rolling sector trend states ----
  const sectorStateByDate = computeSectorStates(history.blocks ?? [], dates);
  // Build per-stock sector history (sorted by date) for forward-looking assignment.
  // For each stock on each date, use the most recent past block_top record's sector.
  const stockSectorHistory = new Map<string, Array<{ date: string; sector: string }>>();
  for (const record of history.limit_up_records ?? []) {
    if (!record.sector_code || !/^\d{6}$/.test(record.sector_code)) continue;
    const list = stockSectorHistory.get(record.stock_code) ?? [];
    list.push({ date: record.date, sector: record.sector_code });
    stockSectorHistory.set(record.stock_code, list);
  }
  for (const list of stockSectorHistory.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---- 1. Flatten all bars into column arrays ----
  const stockCodes: string[] = [];
  const stockNames: string[] = [];
  const barDates: string[] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const volumes: number[] = [];
  const amounts: number[] = [];
  const changePcts: number[] = [];
  const trendStrengths: number[] = [];
  const limitUpFlags: number[] = [];
  const sectorStateIds: number[] = [];

  for (const stock of history.stocks) {
    const bars = [...stock.bars].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const n = bars.length;
    const closeArr = new Float64Array(n);
    const dateArr: string[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      closeArr[i] = Number(bars[i][2]);
      dateArr[i] = String(bars[i][0]).replaceAll('-', '').slice(0, 8);
    }
    const { strength, limitUp } = computeStockArrays(
      closeArr,
      dateArr,
      limitUpDatesByCode.get(stock.stock_code),
    );
    // Sector state for this stock on each date: walk forward through sector history
    // to find the most recent block_top record on or before the current bar date.
    const sectorHistory = stockSectorHistory.get(stock.stock_code);
    let sectorCursor = 0;
    let currentSector: string | undefined;
    for (let i = 0; i < n; i += 1) {
      stockCodes.push(stock.stock_code);
      stockNames.push(stock.stock_name);
      barDates.push(dateArr[i]);
      opens.push(Number(bars[i][1]));
      closes.push(closeArr[i]);
      highs.push(Number(bars[i][3]));
      lows.push(Number(bars[i][4]));
      volumes.push(Number(bars[i][5]));
      amounts.push(Number(bars[i][6]));
      changePcts.push(Number(bars[i][7]));
      trendStrengths.push(strength[i]);
      limitUpFlags.push(limitUp[i]);
      // Advance cursor while records are on or before the current bar date
      while (sectorHistory && sectorCursor < sectorHistory.length && sectorHistory[sectorCursor].date <= dateArr[i]) {
        currentSector = sectorHistory[sectorCursor].sector;
        sectorCursor += 1;
      }
      const stateMap = currentSector ? sectorStateByDate.get(currentSector) : undefined;
      sectorStateIds.push(stateMap?.get(dateArr[i]) ?? 0);
    }
  }

  if (!stockCodes.length) return new Map();

  // ---- 2. Build DataFrame ----
  let frame = pl.DataFrame({
    stock_code: stockCodes,
    stock_name: stockNames,
    date: barDates,
    open: opens,
    close: closes,
    high: highs,
    low: lows,
    volume: volumes,
    amount: amounts,
    change_pct: changePcts,
    trend_strength: trendStrengths,
    limit_up_flag: limitUpFlags,
    sector_state_id: sectorStateIds,
  }).sort(['stock_code', 'date']);

  // ---- 3. Rolling features (per stock) ----
  const g = 'stock_code';
  frame = frame.withColumns(
    pl.col('close').rollingMean({ windowSize: 5 }).over(g).alias('ma5'),
    pl.col('close').rollingMean({ windowSize: 10 }).over(g).alias('ma10'),
    pl.col('close').rollingMean({ windowSize: 20 }).over(g).alias('ma20'),
    pl.col('close').rollingMean({ windowSize: 60 }).over(g).alias('ma60'),
    pl.col('volume').rollingMean({ windowSize: 5 }).over(g).alias('vol_recent_5'),
    pl.col('volume').shift(5).rollingMean({ windowSize: 5 }).over(g).alias('vol_prev_5'),
    pl.col('high').rollingMax({ windowSize: 60, minPeriods: 1 }).over(g).alias('high_60d'),
    pl.col('low').rollingMin({ windowSize: 60, minPeriods: 1 }).over(g).alias('low_60d'),
    pl.col('close').shift(1).over(g).alias('prev_close'),
    pl.col('limit_up_flag').rollingSum({ windowSize: 20 }).over(g).alias('limit_up_count_20d'),
    pl.col('close').cumCount().over(g).sub(1).alias('bar_idx'),
  );

  // ---- 4. Derived features ----
  frame = frame.withColumns(
    // Volume ratio (guard division by zero)
    pl.when(pl.col('vol_prev_5').isNull().or(pl.col('vol_prev_5').eq(0)))
      .then(pl.lit(1.0))
      .otherwise(pl.col('vol_recent_5').div(pl.col('vol_prev_5')))
      .alias('volume_ratio'),
    // Price change pct
    pl.when(pl.col('prev_close').isNull().or(pl.col('prev_close').eq(0)))
      .then(pl.lit(0.0))
      .otherwise(pl.col('close').sub(pl.col('prev_close')).div(pl.col('prev_close')).mul(100))
      .alias('price_change_pct'),
    // Distance from 60d high (in %)
    pl.when(pl.col('high_60d').isNull().or(pl.col('high_60d').eq(0)))
      .then(pl.lit(0.0))
      .otherwise(pl.col('close').sub(pl.col('high_60d')).div(pl.col('high_60d')).mul(100))
      .alias('distance_from_high_pct'),
    // Distance from 60d low (in %) — 从60日最低点反弹的涨幅
    pl.when(pl.col('low_60d').isNull().or(pl.col('low_60d').eq(0)))
      .then(pl.lit(0.0))
      .otherwise(pl.col('close').sub(pl.col('low_60d')).div(pl.col('low_60d')).mul(100))
      .alias('distance_from_low_pct'),
  );

  // ---- 5. Alignment classification ----
  frame = frame.withColumns(
    pl.when(pl.col('ma5').isNull().or(pl.col('ma10').isNull()).or(pl.col('ma20').isNull()).or(pl.col('ma60').isNull()))
      .then(pl.lit('tangled'))
      .when(pl.col('ma5').gt(pl.col('ma10')).and(pl.col('ma10').gt(pl.col('ma20'))).and(pl.col('ma20').gt(pl.col('ma60'))))
      .then(pl.lit('bullish'))
      .when(pl.col('ma5').lt(pl.col('ma10')).and(pl.col('ma10').lt(pl.col('ma20'))).and(pl.col('ma20').lt(pl.col('ma60'))))
      .then(pl.lit('bearish'))
      .otherwise(pl.lit('tangled'))
      .alias('alignment'),
  );

  // ---- 6. Dimension 1: Trend score (0-40) ----
  // Sector bonus: states 1-3 (up) → +4, states 6-7 (down) → -4, else 0
  frame = frame.withColumns(
    pl.col('trend_strength').mul(400).clip(-12, 12).alias('trend_bonus'),
    pl.when(pl.col('sector_state_id').eq(pl.lit(8))
      .or(pl.col('sector_state_id').gtEq(1).and(pl.col('sector_state_id').ltEq(3)))).then(pl.lit(4))
      .when(pl.col('sector_state_id').gtEq(6)).then(pl.lit(-4))
      .otherwise(pl.lit(0))
      .alias('sector_bonus'),
  ).withColumns(
    pl.when(pl.col('alignment').eq(pl.lit('bullish'))).then(pl.lit(28))
      .when(pl.col('alignment').eq(pl.lit('bearish'))).then(pl.lit(0))
      .otherwise(pl.lit(14))
      .add(pl.col('trend_bonus'))
      .add(pl.col('sector_bonus'))
      .clip(0, 40)
      .alias('trend_score'),
  );

  // ---- 7. Dimension 2: Volume-price score (0-25) ----
  const bigVol = pl.col('volume_ratio').gt(1.5);
  const modVol = pl.col('volume_ratio').gtEq(1.1).and(pl.col('volume_ratio').ltEq(1.5));
  const lowVol = pl.col('volume_ratio').lt(0.8);
  const bigGain = pl.col('price_change_pct').gt(5);
  const mildGain = pl.col('price_change_pct').gt(3).and(pl.col('price_change_pct').ltEq(5));
  const smallGain = pl.col('price_change_pct').gt(0).and(pl.col('price_change_pct').ltEq(3));
  const decline = pl.col('price_change_pct').lt(0);
  const nearHigh = pl.col('distance_from_high_pct').gt(-5);
  const farHigh = pl.col('distance_from_high_pct').lt(-15);
  const stagnation = pl.col('price_change_pct').gtEq(-1).and(pl.col('price_change_pct').ltEq(1)).and(pl.col('volume_ratio').gt(1.5));

  frame = frame.withColumns(
    pl.when(pl.col('bar_idx').lt(9)).then(pl.lit(8))
      .when(bigVol.and(bigGain).and(nearHigh)).then(pl.lit(2))
      .when(bigVol.and(stagnation).and(nearHigh)).then(pl.lit(1))
      .when(bigVol.and(decline)).then(pl.lit(2))
      .when(bigVol.and(bigGain.or(mildGain)).and(farHigh)).then(pl.lit(20))
      .when(bigVol.and(smallGain).and(farHigh)).then(pl.lit(18))
      .when(bigVol.and(stagnation)).then(pl.lit(10))
      .when(bigVol.and(bigGain)).then(pl.lit(12))
      .when(modVol.and(smallGain).and(nearHigh.not())).then(pl.lit(22))
      .when(modVol.and(smallGain).and(nearHigh)).then(pl.lit(14))
      .when(modVol.and(mildGain.or(bigGain))).then(pl.lit(15))
      .when(modVol.and(decline)).then(pl.lit(8))
      .when(lowVol.and(pl.col('price_change_pct').gt(0))).then(pl.lit(12))
      .when(lowVol.and(decline)).then(pl.lit(10))
      .otherwise(pl.lit(10))
      .alias('volume_price_score'),
    // Label
    pl.when(pl.col('bar_idx').lt(9)).then(pl.lit('样本不足'))
      .when(bigVol.and(bigGain).and(nearHigh)).then(pl.lit('顶部放量'))
      .when(bigVol.and(stagnation).and(nearHigh)).then(pl.lit('高位滞涨'))
      .when(bigVol.and(decline)).then(pl.lit('放量下跌'))
      .when(bigVol.and(bigGain.or(mildGain)).and(farHigh)).then(pl.lit('启动放量'))
      .when(bigVol.and(smallGain).and(farHigh)).then(pl.lit('低位启动'))
      .when(bigVol.and(stagnation)).then(pl.lit('放量滞涨'))
      .when(bigVol.and(bigGain)).then(pl.lit('追高放量'))
      .when(modVol.and(smallGain).and(nearHigh.not())).then(pl.lit('稳健放量'))
      .when(modVol.and(smallGain).and(nearHigh)).then(pl.lit('高位稳量'))
      .when(modVol.and(mildGain.or(bigGain))).then(pl.lit('温和放量'))
      .when(modVol.and(decline)).then(pl.lit('健康回调'))
      .when(lowVol.and(pl.col('price_change_pct').gt(0))).then(pl.lit('缩量上涨'))
      .when(lowVol.and(decline)).then(pl.lit('缩量下跌'))
      .otherwise(pl.lit('量价均衡'))
      .alias('volume_price_label'),
  );

  // ---- 8. Dimension 3: Distance-from-60d-low score (0-20) ----
  frame = frame.withColumns(
    pl.when(pl.col('distance_from_low_pct').lt(0)).then(pl.lit(2))
      .when(pl.col('distance_from_low_pct').lt(5)).then(pl.lit(4))
      .when(pl.col('distance_from_low_pct').lt(15)).then(pl.lit(10))
      .when(pl.col('distance_from_low_pct').lt(30)).then(pl.lit(18))
      .when(pl.col('distance_from_low_pct').lt(50)).then(pl.lit(20))
      .when(pl.col('distance_from_low_pct').lt(80)).then(pl.lit(14))
      .otherwise(pl.lit(8))
      .alias('position_score'),
    pl.when(pl.col('distance_from_low_pct').lt(0)).then(pl.lit('贴近低点'))
      .when(pl.col('distance_from_low_pct').lt(5)).then(pl.lit('贴近低点'))
      .when(pl.col('distance_from_low_pct').lt(15)).then(pl.lit('刚离低点'))
      .when(pl.col('distance_from_low_pct').lt(30)).then(pl.lit('启动确认'))
      .when(pl.col('distance_from_low_pct').lt(50)).then(pl.lit('趋势上行'))
      .when(pl.col('distance_from_low_pct').lt(80)).then(pl.lit('远离低点'))
      .otherwise(pl.lit('高位延伸'))
      .alias('position_label'),
  );

  // ---- 9. Dimension 4: Volatility-trend score (0-15) ----
  // trend_axis: prefer sector state_id when available, fallback to alignment
  frame = frame.withColumns(
    pl.when(pl.col('limit_up_count_20d').gtEq(3)).then(pl.lit('high'))
      .when(pl.col('limit_up_count_20d').gtEq(1)).then(pl.lit('medium'))
      .otherwise(pl.lit('low'))
      .alias('volatility_class'),
    pl.when(pl.col('sector_state_id').eq(pl.lit(8))
      .or(pl.col('sector_state_id').gtEq(1).and(pl.col('sector_state_id').ltEq(3)))).then(pl.lit('up'))
      .when(pl.col('sector_state_id').gtEq(6)).then(pl.lit('down'))
      .when(pl.col('sector_state_id').gtEq(4).and(pl.col('sector_state_id').ltEq(5))).then(pl.lit('range'))
      .when(pl.col('alignment').eq(pl.lit('bullish'))).then(pl.lit('up'))
      .when(pl.col('alignment').eq(pl.lit('bearish'))).then(pl.lit('down'))
      .otherwise(pl.lit('range'))
      .alias('trend_axis'),
  );

  // Cross matrix: volatility × trend_axis
  frame = frame.withColumns(
    pl.when(pl.col('volatility_class').eq(pl.lit('high')))
      .then(pl.when(pl.col('trend_axis').eq(pl.lit('up'))).then(pl.lit(15))
        .when(pl.col('trend_axis').eq(pl.lit('range'))).then(pl.lit(8))
        .otherwise(pl.lit(1)))
      .when(pl.col('volatility_class').eq(pl.lit('medium')))
      .then(pl.when(pl.col('trend_axis').eq(pl.lit('up'))).then(pl.lit(12))
        .when(pl.col('trend_axis').eq(pl.lit('range'))).then(pl.lit(6))
        .otherwise(pl.lit(3)))
      .otherwise(pl.when(pl.col('trend_axis').eq(pl.lit('up'))).then(pl.lit(8))
        .when(pl.col('trend_axis').eq(pl.lit('range'))).then(pl.lit(4))
        .otherwise(pl.lit(5)))
      .alias('volatility_trend_score'),
  );

  // ---- 10. Total score ----
  frame = frame.withColumns(
    pl.col('trend_score')
      .add(pl.col('volume_price_score'))
      .add(pl.col('position_score'))
      .add(pl.col('volatility_trend_score'))
      .alias('total_score'),
  );

  // ---- 9. Filter to valid scoring rows and requested dates ----
  frame = frame.filter(
    pl.col('ma20').isNotNull()
      .and(pl.col('volume').gt(0))
      .and(pl.col('open').gt(0))
      .and(pl.col('close').gt(0))
      .and(pl.col('date').isIn([...dateSet])),
  );

  // ---- 10. Extract to JS and group by date ----
  const records = frame.toRecords() as Record<string, unknown>[];
  const byDate = new Map<string, RankingRow[]>();
  for (const row of records) {
    const date = String(row.date);
    const list = byDate.get(date) ?? [];
    list.push({
      rank: 0,
      stock_code: String(row.stock_code),
      stock_name: String(row.stock_name),
      total_score: round(Number(row.total_score), 1),
      trend_score: round(Number(row.trend_score), 1),
      volume_price_score: Number(row.volume_price_score),
      volume_score: Number(row.volume_price_score),
      volume_price_label: String(row.volume_price_label),
      volume_label: String(row.volume_price_label),
      position_score: Number(row.position_score),
      position_label: String(row.position_label),
      volatility_trend_score: Number(row.volatility_trend_score),
      volatility_class: String(row.volatility_class) as VolatilityClass,
      volatility_label: ({ high: '高波动', medium: '中波动', low: '低波动' } as Record<string, string>)[String(row.volatility_class)] ?? '',
      limit_up_count_20d: Number(row.limit_up_count_20d),
      alignment: String(row.alignment),
      trend_strength: round(Number(row.trend_strength), 4),
      distance_from_low_pct: round(Number(row.distance_from_low_pct), 2),
      latest_price: Number(row.close),
      latest_change_rate: Number(row.change_pct),
    });
    byDate.set(date, list);
  }

  // Sort each date's rows by total_score desc, assign ranks
  for (const [, rows] of byDate) {
    rows.sort((a, b) => b.total_score - a.total_score || a.stock_code.localeCompare(b.stock_code));
    for (let i = 0; i < rows.length; i += 1) rows[i].rank = i + 1;
  }

  return byDate;
}
