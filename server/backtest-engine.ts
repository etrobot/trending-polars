import pl from 'nodejs-polars';
import type { BacktestResult, BacktestTrade, EquityPoint, RankingRow } from '../src/types.js';
import { computeBacktestScores } from './backtest-scoring.js';
import { compactDate, formatDateTime, round } from './format.js';
import { normalizeBacktestDays, type HistoricalMarketData } from './historical-market.js';
import {
  applySectorStrategyScore,
  compareByScore,
  prepareSeries,
  scoreStock,
  DIMENSION_MAX,
  RAW_SCORE_MAX,
  SCORE_SCALE,
  type PreparedSeries,
  type SectorContext,
  type ScoreStockConfig,
  DEFAULT_SCORE_STOCK_CONFIG,
  normalizeScoreStockConfig,
} from './scoring-engine.js';
import { benchmarkReturns } from './backtest-scoring.js';
import {
  calculateEntrySize,
  commission,
  createT1StrategyConfig,
  DEFAULT_T1_STRATEGY,
  exitSignalReason,
  rankEntryCandidates,
} from './trading-strategy.js';

interface Position {
  stockCode: string;
  stockName: string;
  buyPrice: number;
  buyDate: string;
  buyIndex: number;
  shares: number;
  grossAmount: number;
  totalCost: number;
}

interface EntryOrder {
  stockCode: string;
  stockName: string;
  rank: number;
  signalDate: string;
  /** 信号日总分；用于按评分缩放仓位（scoreScaledSizing）。 */
  totalScore: number;
}

interface BacktestContext {
  dates: string[];
  prepared: PreparedSeries[];
  seriesByCode: Map<string, PreparedSeries>;
  exactLimitUpCodes: Map<string, Set<string>>;
  scoreMap: ReturnType<typeof computeBacktestScores>;
}

interface SimulatedBacktest {
  cash: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  maxHoldings: number;
}

interface BacktestSummarySnapshot {
  finalCapital: number;
  totalReturn: number;
  totalReturnPct: number;
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  winCount: number;
  winRate: number;
  expireCount: number;
  maxHoldings: number;
  maxDrawdownPct: number;
}

interface FactorWeights {
  trendWeightPct: number;
  volumePriceWeightPct: number;
  /** 距60日低点（position_score）权重 */
  distanceFromLowWeightPct: number;
  volatilityTrendWeightPct: number;
  /** 相对强度（relative_strength_score）权重 */
  relativeStrengthWeightPct: number;
}

export type { FactorWeights };

interface BacktestRunMeta {
  mode: 'current' | 'random';
  batchSize?: number;
  comboIndex?: number;
  batchRunId?: string;
  factorWeights?: FactorWeights;
  scoringConfig?: ScoreStockConfig;
  bounds?: {
    maxHoldDays: number;
    maxPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
    positionSizePct: number;
    trendWeightPct: number;
    volumePriceWeightPct: number;
    distanceFromLowWeightPct: number;
    volatilityTrendWeightPct: number;
    relativeStrengthWeightPct: number;
  };
}

const INITIAL_CAPITAL = 100_000;

const DEFAULT_FACTOR_WEIGHTS: FactorWeights = {
  trendWeightPct: 100,
  volumePriceWeightPct: 100,
  distanceFromLowWeightPct: 100,
  volatilityTrendWeightPct: 100,
  relativeStrengthWeightPct: 100,
};

export { DEFAULT_FACTOR_WEIGHTS };

/**
 * 因子权重范围。归一化之后权重可以「加强」而不只是「削弱」某个维度，
 * 所以上界放到 200（100 为中性）。旧的 [1,100] 上限让优化器只能往下调，
 * 相当于把「强调 trend」和「削弱其它三维」混为一谈。
 */
const MIN_FACTOR_WEIGHT_PCT = 1;
const MAX_FACTOR_WEIGHT_PCT = 200;

function clampWeightPct(value: number | undefined, fallback: number): number {
  const numeric = Math.trunc(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_FACTOR_WEIGHT_PCT, Math.max(MIN_FACTOR_WEIGHT_PCT, numeric));
}

function normalizeFactorWeights(weights?: Partial<FactorWeights>): FactorWeights {
  return {
    trendWeightPct: clampWeightPct(weights?.trendWeightPct, DEFAULT_FACTOR_WEIGHTS.trendWeightPct),
    volumePriceWeightPct: clampWeightPct(weights?.volumePriceWeightPct, DEFAULT_FACTOR_WEIGHTS.volumePriceWeightPct),
    distanceFromLowWeightPct: clampWeightPct(weights?.distanceFromLowWeightPct, DEFAULT_FACTOR_WEIGHTS.distanceFromLowWeightPct),
    volatilityTrendWeightPct: clampWeightPct(weights?.volatilityTrendWeightPct, DEFAULT_FACTOR_WEIGHTS.volatilityTrendWeightPct),
    relativeStrengthWeightPct: clampWeightPct(weights?.relativeStrengthWeightPct, DEFAULT_FACTOR_WEIGHTS.relativeStrengthWeightPct),
  };
}

export { normalizeFactorWeights, MIN_FACTOR_WEIGHT_PCT, MAX_FACTOR_WEIGHT_PCT };

/**
 * 按因子权重重算总分并重新排名。
 *
 * 权重是**归一化**的：加权和会被除以「本组权重下的理论满分」再放大回 SCORE_SCALE（100 分制），
 * 所以调权重只改变五维的相对影响，不改变总分量纲。
 *
 * 这一点是必须的 —— 下游全是绝对阈值（rankEntryCandidates 的入场线、
 * strategyForScore 的 70/55/40/25/10 分档）。若按旧写法直接乘 pct/100，权重只能往下调，
 * 总分就只会缩水：例如 (trend 70, distance 70) 会把理论满分压到 82，40 分的入场线
 * 等效变成原口径的 48.8 分。于是参数优化器搜索权重时，同时改变了「因子相对权重」和
 * 「绝对入场门槛」两件事，两个效应完全纠缠，搜出来的最优权重无法解释。
 *
 * 板块情境修正不参与五维权重归一化，而是在加权基础分之后原值应用；
 * 否则追高/暴力反弹的风险扣分会被某组因子权重意外稀释。
 * 全 100（默认值）时结果与未加权的 scoreStock 完全一致。
 */
function applyFactorWeights(rows: RankingRow[], weights: FactorWeights): RankingRow[] {
  const trendMul = weights.trendWeightPct / 100;
  const volumeMul = weights.volumePriceWeightPct / 100;
  const fromLowMul = weights.distanceFromLowWeightPct / 100;
  const volatilityMul = weights.volatilityTrendWeightPct / 100;
  const strengthMul = weights.relativeStrengthWeightPct / 100;
  const maxWeighted = DIMENSION_MAX.trend * trendMul
    + DIMENSION_MAX.volumePrice * volumeMul
    + DIMENSION_MAX.distanceFromLow * fromLowMul
    + DIMENSION_MAX.volatilityTrend * volatilityMul
    + DIMENSION_MAX.relativeStrength * strengthMul;
  const normalizer = maxWeighted > 0 ? SCORE_SCALE / maxWeighted : 1;
  const rescored = rows.map((row) => {
    const weighted = row.trend_score * trendMul
      + Number(row.volume_price_score ?? row.volume_score ?? 0) * volumeMul
      + Number(row.position_score ?? 0) * fromLowMul
      + Number(row.volatility_trend_score ?? 0) * volatilityMul
      + Number(row.relative_strength_score ?? 0) * strengthMul;
    return {
      ...row,
      total_score: applySectorStrategyScore(weighted * normalizer, Number(row.sector_strategy_score ?? 0)),
    };
  });
  rescored.sort(compareByScore);
  for (let index = 0; index < rescored.length; index += 1) rescored[index].rank = index + 1;
  return rescored;
}

function limitUpDatesByCode(history: HistoricalMarketData): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const record of history.limit_up_records ?? []) {
    const date = record.date.replaceAll('-', '').slice(0, 8);
    const dates = result.get(record.stock_code) ?? new Set<string>();
    dates.add(date);
    result.set(record.stock_code, dates);
  }
  return result;
}

function limitUpCodesByDate(history: HistoricalMarketData): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const record of history.limit_up_records ?? []) {
    const date = record.date.replaceAll('-', '').slice(0, 8);
    const codes = result.get(date) ?? new Set<string>();
    codes.add(record.stock_code);
    result.set(date, codes);
  }
  return result;
}

function candidatesAtDate(series: PreparedSeries[], date: string, exactLimitUpDates: Map<string, Set<string>>): RankingRow[] {
  const rows = series.map((item) => scoreStock(item, date, {
    limitUpDates: exactLimitUpDates.get(item.stockCode),
  })).filter((item): item is RankingRow => item != null);
  const records = rankEntryCandidates(rows, new Set(), DEFAULT_T1_STRATEGY.maxCandidates);
  return records.map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * 板块 state_id → 趋势轴。
 *
 * 拿不到板块状态时返回 undefined，**不得**回退到个股自身的均线排列：
 * `sector.trend` 会同时驱动维度 1 的板块加分（±4）和维度 4 的趋势轴，用个股
 * alignment 冒充板块趋势等于把同一个信号重复计入 2~3 次（bullish 白拿 +4 与
 * 更高的波动率矩阵列），且与向量化回测路径（sector_state_id=0 → bonus 0）不一致。
 * 维度 4 的 alignment 回退由 scoreStock 内部完成，两条路径口径一致。
 */
function trendAxisFromState(stateId: number | undefined): 'up' | 'range' | 'down' | undefined {
  if (stateId == null) return undefined;
  if ([1, 2, 3, 8].includes(stateId)) return 'up';
  if ([6, 7].includes(stateId)) return 'down';
  if ([4, 5].includes(stateId)) return 'range';
  return undefined;
}

export interface SectorTrendLookup {
  sector_code: string;
  sector_name: string;
  state_id: number;
  state_name: string;
}

export function sectorTrendLookupMap(
  records: Array<{ sector_code: string; sector_name: string; state_id: number; state_name: string }>,
): Map<string, SectorTrendLookup> {
  return new Map(records.map((record) => [record.sector_code, record]));
}

function sectorContextForRanking(
  previous: RankingRow | undefined,
  sectorTrendsByCode: Map<string, SectorTrendLookup>,
  limitUpDates: ReadonlySet<string> | undefined,
  benchmarkReturnPct: number | null | undefined,
): SectorContext {
  const sectorCode = String(previous?.sector_code ?? '').trim();
  const trend = sectorCode ? sectorTrendsByCode.get(sectorCode) : undefined;
  if (trend) {
    return {
      trend: trendAxisFromState(trend.state_id),
      trendName: trend.state_name,
      stateId: trend.state_id,
      code: trend.sector_code,
      name: trend.sector_name || previous?.sector_name,
      limitUpDates,
      benchmarkReturnPct,
    };
  }
  return {
    trend: trendAxisFromState(previous?.sector_trend_state_id),
    trendName: previous?.sector_trend_name,
    stateId: previous?.sector_trend_state_id,
    code: previous?.sector_code,
    name: previous?.sector_name,
    limitUpDates,
    benchmarkReturnPct,
  };
}

/** Build the complete as-of-date cross section from persisted K lines. */
export interface CrossSectionRankingOptions {
  scoringConfig?: ScoreStockConfig;
  factorWeights?: FactorWeights;
}

export function historicalCrossSectionRankings(
  history: HistoricalMarketData,
  date: string,
  previousRows: RankingRow[] = [],
  sectorTrendsByCode: Map<string, SectorTrendLookup> = new Map(),
  options: CrossSectionRankingOptions = {},
): RankingRow[] {
  // 实盘截面计算的配置可能来自旧的 ranking-config.json（缺 relativeStrength/marketState），
  // 用 normalize 与默认值对齐，避免 relativeStrength.lookback 读取到 undefined 而崩溃。
  const scoringConfig = options.scoringConfig
    ? normalizeScoreStockConfig(options.scoringConfig)
    : DEFAULT_SCORE_STOCK_CONFIG;
  const factorWeights = options.factorWeights ?? DEFAULT_FACTOR_WEIGHTS;
  const targetDate = date.replaceAll('-', '').slice(0, 8);
  const previousByCode = new Map(previousRows.map((row) => [row.stock_code, row]));
  const exactLimitUpDates = limitUpDatesByCode(history);
  // 维度 5 的基准：与向量化回测取同一条上证指数曲线、同一 lookback。
  const benchmarkReturnPct = benchmarkReturns(history, scoringConfig.relativeStrength.lookback).get(targetDate);
  const scored = history.stocks.flatMap((stock): RankingRow[] => {
    const previous = previousByCode.get(stock.stock_code);
    const row = scoreStock(
      prepareSeries(stock),
      targetDate,
      sectorContextForRanking(previous, sectorTrendsByCode, exactLimitUpDates.get(stock.stock_code), benchmarkReturnPct),
      scoringConfig,
    );
    if (!row) return [];
    return [{
      ...previous,
      ...row,
      continue_num: previous?.continue_num,
      reason_info: previous?.reason_info,
    }];
  });
  const ranked = scored
    .sort(compareByScore)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return applyFactorWeights(ranked, factorWeights);
}

export function historicalStrategyCandidates(history: HistoricalMarketData, date: string): RankingRow[] {
  return rankEntryCandidates(historicalCrossSectionRankings(history, date), new Set(), DEFAULT_T1_STRATEGY.maxCandidates)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function drawdownPercent(values: number[]): number {
  let peak = values[0] ?? 0;
  let maxDrawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (value - peak) / peak);
  }
  return round(maxDrawdown * 100, 2);
}

function sellPosition(
  position: Position,
  rawPrice: number,
  date: string,
  dateIndex: number,
  reason: string,
): { trade: BacktestTrade; cashProceeds: number } {
  const fillPrice = round(rawPrice * (1 - DEFAULT_T1_STRATEGY.slippageRate), 3);
  const grossAmount = round(fillPrice * position.shares, 2);
  const fees = commission(grossAmount) + round(grossAmount * DEFAULT_T1_STRATEGY.stampTaxRate, 2);
  const cashProceeds = round(grossAmount - fees, 2);
  const pnlAmount = round(cashProceeds - position.totalCost, 2);
  const pnlPct = position.totalCost > 0 ? round(pnlAmount / position.totalCost * 100, 2) : 0;
  return {
    cashProceeds,
    trade: {
      date,
      stock_code: position.stockCode,
      stock_name: position.stockName,
      action: '卖出',
      price: fillPrice,
      shares: position.shares,
      amount: grossAmount,
      position_pct: round(position.grossAmount / INITIAL_CAPITAL * 100, 1),
      hold_days: Math.max(0, dateIndex - position.buyIndex),
      pnl_pct: pnlPct,
      pnl_amount: pnlAmount,
      reason,
    },
  };
}

function buildBacktestContext(
  history: HistoricalMarketData,
  days: number,
  scoringConfig: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
): BacktestContext {
  const dates = history.calendar.filter((date) => date <= history.as_of_date).slice(-days);
  if (dates.length < 2) throw new Error('历史数据不足，至少需要两个交易日');
  const exactLimitUpDates = limitUpDatesByCode(history);
  const prepared = history.stocks.map(prepareSeries);
  return {
    dates,
    exactLimitUpCodes: limitUpCodesByDate(history),
    scoreMap: computeBacktestScores(history, dates, exactLimitUpDates, scoringConfig),
    prepared,
    seriesByCode: new Map(prepared.map((series) => [series.stockCode, series] as const)),
  };
}

function simulateBacktest(
  context: BacktestContext,
  strategy: ReturnType<typeof createT1StrategyConfig>,
  factorWeights: FactorWeights = DEFAULT_FACTOR_WEIGHTS,
): SimulatedBacktest {
  const { dates, prepared, seriesByCode, exactLimitUpCodes, scoreMap } = context;
  const positions = new Map<string, Position>();
  const pendingExits = new Map<string, string>();
  const lastKnownClose = new Map<string, number>();
  let pendingEntries: EntryOrder[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let cash = INITIAL_CAPITAL;
  let maxHoldings = 0;

  for (let dateIndex = 0; dateIndex < dates.length; dateIndex += 1) {
    const date = dates[dateIndex];

    for (const [code, reason] of [...pendingExits]) {
      const position = positions.get(code);
      const series = seriesByCode.get(code);
      const barIndex = series?.indexByDate.get(date);
      const bar = barIndex == null ? null : series?.bars[barIndex];
      if (!position) {
        pendingExits.delete(code);
        continue;
      }
      if (!bar?.open || bar.open <= 0) continue;
      const sold = sellPosition(position, bar.open, date, dateIndex, reason);
      cash = round(cash + sold.cashProceeds, 2);
      trades.push(sold.trade);
      positions.delete(code);
      pendingExits.delete(code);
    }

    const entriesForToday = pendingEntries;
    pendingEntries = [];
    for (const order of entriesForToday.slice(0, strategy.maxEntriesPerDay)) {
      if (positions.size >= strategy.maxPositions) break;
      if (positions.has(order.stockCode)) continue;
      const series = seriesByCode.get(order.stockCode);
      const barIndex = series?.indexByDate.get(date);
      const bar = barIndex == null ? null : series?.bars[barIndex];
      if (!series || !bar?.open || bar.open <= 0) continue;
      if (exactLimitUpCodes.get(date)?.has(order.stockCode)) continue;

      const fillPrice = round(bar.open * (1 + strategy.slippageRate), 3);
      const sizing = calculateEntrySize(cash, INITIAL_CAPITAL, fillPrice, strategy, order.totalScore);
      if (!sizing) continue;
      cash = round(cash - sizing.totalCost, 2);
      positions.set(order.stockCode, {
        stockCode: order.stockCode,
        stockName: order.stockName,
        buyPrice: fillPrice,
        buyDate: date,
        buyIndex: dateIndex,
        shares: sizing.shares,
        grossAmount: sizing.grossAmount,
        totalCost: sizing.totalCost,
      });
      trades.push({
        date,
        stock_code: order.stockCode,
        stock_name: order.stockName,
        action: '买入',
        price: fillPrice,
        shares: sizing.shares,
        amount: sizing.grossAmount,
        position_pct: round(sizing.grossAmount / INITIAL_CAPITAL * 100, 1),
        hold_days: 0,
        pnl_pct: 0,
        pnl_amount: 0,
        reason: `信号日${order.signalDate} 排名#${order.rank} 次日开盘`,
      });
    }
    maxHoldings = Math.max(maxHoldings, positions.size);

    for (const series of prepared) {
      const barIndex = series.indexByDate.get(date);
      if (barIndex != null) lastKnownClose.set(series.stockCode, series.bars[barIndex].close);
    }

    for (const [code, position] of positions) {
      if (pendingExits.has(code)) continue;
      const close = lastKnownClose.get(code);
      if (!close || close <= 0) continue;
      const pnlPct = (close - position.buyPrice) / position.buyPrice * 100;
      const holdDays = dateIndex - position.buyIndex;
      const reason = exitSignalReason(pnlPct, holdDays, strategy);
      if (reason && dateIndex < dates.length - 1) pendingExits.set(code, reason);
    }

    const positionValue = [...positions.values()].reduce(
      (sum, position) => sum + position.shares * (lastKnownClose.get(position.stockCode) ?? position.buyPrice),
      0,
    );
    equityCurve.push({
      date,
      cash: round(cash, 2),
      positions_value: round(positionValue, 2),
      total: round(cash + positionValue, 2),
    });

    if (dateIndex < dates.length - 1) {
      const heldOrOrdered = new Set([...positions.keys(), ...pendingEntries.map((order) => order.stockCode)]);
      const availableSlots = Math.max(0, strategy.maxPositions - positions.size);
      const dayScores = applyFactorWeights(scoreMap.get(date) ?? [], factorWeights);
      pendingEntries = rankEntryCandidates(dayScores, new Set(), DEFAULT_T1_STRATEGY.maxCandidates, strategy.minEntryScore)
        .filter((candidate) => !heldOrOrdered.has(candidate.stock_code))
        .slice(0, Math.min(strategy.maxEntriesPerDay, availableSlots))
        .map((candidate) => ({
          stockCode: candidate.stock_code,
          stockName: candidate.stock_name,
          rank: candidate.rank,
          signalDate: date,
          totalScore: Number(candidate.total_score ?? 0),
        }));
    }
  }

  const finalDate = dates.at(-1)!;
  const finalDateIndex = dates.length - 1;
  for (const position of [...positions.values()]) {
    const finalPrice = lastKnownClose.get(position.stockCode) ?? position.buyPrice;
    const sold = sellPosition(position, finalPrice, finalDate, finalDateIndex, '回测结束按收盘清仓');
    cash = round(cash + sold.cashProceeds, 2);
    trades.push(sold.trade);
    positions.delete(position.stockCode);
  }
  if (equityCurve.length) {
    equityCurve[equityCurve.length - 1] = { date: finalDate, cash, positions_value: 0, total: cash };
  }

  trades.sort((left, right) => left.date.localeCompare(right.date)
    || (left.action === right.action ? 0 : left.action === '买入' ? -1 : 1));

  return { cash, trades, equityCurve, maxHoldings };
}

function summarizeSimulation(simulation: SimulatedBacktest): BacktestSummarySnapshot {
  const sellTrades = simulation.trades.filter((trade) => trade.action === '卖出');
  const sellFrame = pl.DataFrame(sellTrades.map((trade) => ({
    pnl_pct: Number(trade.pnl_pct),
    pnl_amount: Number(trade.pnl_amount ?? 0),
    hold_days: Number(trade.hold_days),
  })));
  const totalReturn = round(simulation.cash - INITIAL_CAPITAL, 2);
  const winCount = sellFrame.height ? sellFrame.filter(pl.col('pnl_amount').gt(0)).height : 0;
  return {
    finalCapital: round(simulation.cash, 2),
    totalReturn,
    totalReturnPct: round(totalReturn / INITIAL_CAPITAL * 100, 2),
    totalTrades: simulation.trades.length,
    buyCount: simulation.trades.length - sellTrades.length,
    sellCount: sellTrades.length,
    winCount,
    winRate: sellTrades.length ? round(winCount / sellTrades.length * 100, 1) : 0,
    expireCount: sellTrades.filter((trade) => trade.reason.startsWith('持仓满')).length,
    maxHoldings: simulation.maxHoldings,
    maxDrawdownPct: drawdownPercent(simulation.equityCurve.map((point) => point.total)),
  };
}

function normalizeStopLossPct(value: number | undefined): number {
  const raw = value ?? DEFAULT_T1_STRATEGY.stopLossPct;
  return -Math.max(1, Math.abs(Math.trunc(raw)));
}

function buildResult(
  history: HistoricalMarketData,
  context: BacktestContext,
  strategy: ReturnType<typeof createT1StrategyConfig>,
  simulation: SimulatedBacktest,
  meta?: BacktestRunMeta,
): BacktestResult {
  const timestamp = formatDateTime();
  const baseRunId = meta?.batchRunId ?? `${compactDate().slice(0, 8)}_${compactDate().slice(8)}`;
  const runId = meta?.comboIndex != null && (meta.batchSize ?? 1) > 1
    ? `${baseRunId}_${String(meta.comboIndex).padStart(3, '0')}`
    : baseRunId;
  const summary = summarizeSimulation(simulation);
  const finalDate = context.dates.at(-1)!;
  const mode = meta?.mode ?? 'current';
  const methodologyPrefix = mode === 'random'
    ? `在上限范围内随机取参的第 ${meta?.comboIndex ?? 1}/${meta?.batchSize ?? 1} 组策略组合；`
    : '按当前方案参数直接回测；';

  console.log('[backtest] buildResult', {
    mode,
    run_id: runId,
    combo_index: meta?.comboIndex ?? 1,
    batch_size: meta?.batchSize ?? 1,
    max_hold_days: strategy.maxHoldDays,
    max_positions: strategy.maxPositions,
    position_size_pct: strategy.positionSizePct,
    take_profit_pct: strategy.takeProfitPct,
    stop_loss_pct: strategy.stopLossPct,
    trend_weight_pct: meta?.factorWeights?.trendWeightPct ?? DEFAULT_FACTOR_WEIGHTS.trendWeightPct,
    volume_price_weight_pct: meta?.factorWeights?.volumePriceWeightPct ?? DEFAULT_FACTOR_WEIGHTS.volumePriceWeightPct,
    distance_from_low_weight_pct: meta?.factorWeights?.distanceFromLowWeightPct ?? DEFAULT_FACTOR_WEIGHTS.distanceFromLowWeightPct,
    volatility_weight_pct: meta?.factorWeights?.volatilityTrendWeightPct ?? DEFAULT_FACTOR_WEIGHTS.volatilityTrendWeightPct,
    relative_strength_weight_pct: meta?.factorWeights?.relativeStrengthWeightPct ?? DEFAULT_FACTOR_WEIGHTS.relativeStrengthWeightPct,
    total_return_pct: summary.totalReturnPct,
    trades: summary.totalTrades,
  });

  return {
    run_id: runId,
    timestamp,
    date_range: `${context.dates[0]} → ${finalDate}`,
    max_hold_days: strategy.maxHoldDays,
    engine_version: mode === 'random' ? 'historical-t1-v3' : 'historical-t1-v2',
    data_source: history.source,
    methodology: `${methodologyPrefix}当日收盘生成信号，下一交易日开盘成交；涨停事实仅使用同花顺 block_top 记录，不从涨跌幅或理论涨停价反推；个股与宽基/中证指数日线按腾讯→新浪→东方财富顺序获取前复权数据，并计入滑点、佣金与卖出印花税。`,
    bias_notes: [
      '股票池来自当前可用排行快照，仍可能存在幸存者偏差；交易信号和成交价格不使用未来行情。',
      '缺少 block_top 记录的日期视为“涨停状态未知”，不会用价格幅度补判。',
    ],
    summary: {
      initial_capital: INITIAL_CAPITAL,
      final_capital: summary.finalCapital,
      total_return: summary.totalReturn,
      total_return_pct: summary.totalReturnPct,
      total_trades: summary.totalTrades,
      buy_count: summary.buyCount,
      sell_count: summary.sellCount,
      win_count: summary.winCount,
      win_rate: summary.winRate,
      expire_count: summary.expireCount,
      max_holdings: summary.maxHoldings,
      max_drawdown_pct: summary.maxDrawdownPct,
    },
    config: {
      mode,
      initial_capital: INITIAL_CAPITAL,
      days: context.dates.length,
      strategy_count: meta?.batchSize ?? 1,
      combo_index: meta?.comboIndex ?? 1,
      batch_run_id: meta?.batchRunId ?? baseRunId,
      max_hold_days: strategy.maxHoldDays,
      max_positions: strategy.maxPositions,
      stop_loss_pct: strategy.stopLossPct,
      take_profit_pct: strategy.takeProfitPct,
      max_positions_per_day: strategy.maxEntriesPerDay,
      position_size_pct: strategy.positionSizePct,
      max_candidates: strategy.maxCandidates,
      max_hold_days_upper: meta?.bounds?.maxHoldDays ?? strategy.maxHoldDays,
      max_positions_upper: meta?.bounds?.maxPositions ?? strategy.maxPositions,
      stop_loss_upper_pct: meta?.bounds?.stopLossPct ?? Math.abs(strategy.stopLossPct),
      take_profit_upper_pct: meta?.bounds?.takeProfitPct ?? strategy.takeProfitPct,
      position_size_upper_pct: meta?.bounds?.positionSizePct ?? strategy.positionSizePct,
      trend_weight_pct: meta?.factorWeights?.trendWeightPct ?? DEFAULT_FACTOR_WEIGHTS.trendWeightPct,
      volume_price_weight_pct: meta?.factorWeights?.volumePriceWeightPct ?? DEFAULT_FACTOR_WEIGHTS.volumePriceWeightPct,
      distance_from_low_weight_pct: meta?.factorWeights?.distanceFromLowWeightPct ?? DEFAULT_FACTOR_WEIGHTS.distanceFromLowWeightPct,
      volatility_weight_pct: meta?.factorWeights?.volatilityTrendWeightPct ?? DEFAULT_FACTOR_WEIGHTS.volatilityTrendWeightPct,
      relative_strength_weight_pct: meta?.factorWeights?.relativeStrengthWeightPct ?? DEFAULT_FACTOR_WEIGHTS.relativeStrengthWeightPct,
      trend_weight_upper_pct: meta?.bounds?.trendWeightPct ?? meta?.factorWeights?.trendWeightPct ?? DEFAULT_FACTOR_WEIGHTS.trendWeightPct,
      volume_price_weight_upper_pct: meta?.bounds?.volumePriceWeightPct ?? meta?.factorWeights?.volumePriceWeightPct ?? DEFAULT_FACTOR_WEIGHTS.volumePriceWeightPct,
      distance_from_low_weight_upper_pct: meta?.bounds?.distanceFromLowWeightPct ?? meta?.factorWeights?.distanceFromLowWeightPct ?? DEFAULT_FACTOR_WEIGHTS.distanceFromLowWeightPct,
      volatility_weight_upper_pct: meta?.bounds?.volatilityTrendWeightPct ?? meta?.factorWeights?.volatilityTrendWeightPct ?? DEFAULT_FACTOR_WEIGHTS.volatilityTrendWeightPct,
      relative_strength_weight_upper_pct: meta?.bounds?.relativeStrengthWeightPct ?? meta?.factorWeights?.relativeStrengthWeightPct ?? DEFAULT_FACTOR_WEIGHTS.relativeStrengthWeightPct,
      slippage_bps: strategy.slippageRate * 10_000,
      commission_bps: strategy.commissionRate * 10_000,
      stamp_tax_bps: strategy.stampTaxRate * 10_000,
      scoring_config_json: meta?.scoringConfig ? JSON.stringify(meta.scoringConfig) : null,
    },
    trades: simulation.trades,
    equity_curve: simulation.equityCurve,
  };
}

export function runPolarsBacktest(
  history: HistoricalMarketData,
  options: {
    days: number;
    maxHoldDays: number;
    maxPositions?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    positionSizePct?: number;
    trendWeightPct?: number;
    volumePriceWeightPct?: number;
    distanceFromLowWeightPct?: number;
    volatilityTrendWeightPct?: number;
    relativeStrengthWeightPct?: number;
    scoringConfig?: ScoreStockConfig;
  },
): BacktestResult {
  const days = normalizeBacktestDays(options.days);
  const strategy = createT1StrategyConfig({
    maxHoldDays: Math.max(1, Math.trunc(options.maxHoldDays || 5)),
    maxPositions: Math.max(1, Math.trunc(options.maxPositions ?? DEFAULT_T1_STRATEGY.maxPositions)),
    stopLossPct: normalizeStopLossPct(options.stopLossPct),
    takeProfitPct: Math.max(1, Math.trunc(options.takeProfitPct ?? DEFAULT_T1_STRATEGY.takeProfitPct)),
    positionSizePct: Math.max(1, Math.trunc(options.positionSizePct ?? DEFAULT_T1_STRATEGY.positionSizePct)),
  });
  const factorWeights = normalizeFactorWeights({
    trendWeightPct: options.trendWeightPct,
    volumePriceWeightPct: options.volumePriceWeightPct,
    distanceFromLowWeightPct: options.distanceFromLowWeightPct,
    volatilityTrendWeightPct: options.volatilityTrendWeightPct,
    relativeStrengthWeightPct: options.relativeStrengthWeightPct,
  });
  const scoringConfig = options.scoringConfig ?? DEFAULT_SCORE_STOCK_CONFIG;
  console.log('[backtest] runPolarsBacktest current scheme', {
    days,
    maxHoldDays: strategy.maxHoldDays,
    maxPositions: strategy.maxPositions,
    positionSizePct: strategy.positionSizePct,
    takeProfitPct: strategy.takeProfitPct,
    stopLossPct: strategy.stopLossPct,
    trendWeightPct: factorWeights.trendWeightPct,
    volumePriceWeightPct: factorWeights.volumePriceWeightPct,
    distanceFromLowWeightPct: factorWeights.distanceFromLowWeightPct,
    volatilityTrendWeightPct: factorWeights.volatilityTrendWeightPct,
    relativeStrengthWeightPct: factorWeights.relativeStrengthWeightPct,
    scoring_config: 'custom',
  });
  const context = buildBacktestContext(history, days, scoringConfig);
  const simulation = simulateBacktest(context, strategy, factorWeights);
  return buildResult(history, context, strategy, simulation, {
    mode: 'current',
    batchSize: 1,
    comboIndex: 1,
    factorWeights,
    scoringConfig,
  });
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function runRandomizedBacktest(
  history: HistoricalMarketData,
  options: {
    days: number;
    strategyCount: number;
    maxHoldDaysUpper: number;
    maxPositionsUpper: number;
    stopLossPctUpper: number;
    takeProfitPctUpper: number;
    positionSizePctUpper: number;
    trendWeightPctUpper?: number;
    volumePriceWeightPctUpper?: number;
    distanceFromLowWeightPctUpper?: number;
    volatilityTrendWeightPctUpper?: number;
    relativeStrengthWeightPctUpper?: number;
    scoringConfig?: ScoreStockConfig;
  },
): BacktestResult[] {
  const days = normalizeBacktestDays(options.days);
  const strategyCount = Math.min(200, Math.max(1, Math.trunc(options.strategyCount || 20)));
  const bounds = {
    maxHoldDays: Math.min(60, Math.max(1, Math.trunc(options.maxHoldDaysUpper || DEFAULT_T1_STRATEGY.maxHoldDays))),
    maxPositions: Math.min(20, Math.max(1, Math.trunc(options.maxPositionsUpper || DEFAULT_T1_STRATEGY.maxPositions))),
    stopLossPct: Math.min(30, Math.max(1, Math.trunc(options.stopLossPctUpper || Math.abs(DEFAULT_T1_STRATEGY.stopLossPct)))),
    takeProfitPct: Math.min(60, Math.max(1, Math.trunc(options.takeProfitPctUpper || DEFAULT_T1_STRATEGY.takeProfitPct))),
    positionSizePct: Math.min(100, Math.max(1, Math.trunc(options.positionSizePctUpper || DEFAULT_T1_STRATEGY.positionSizePct))),
    trendWeightPct: clampWeightPct(options.trendWeightPctUpper, DEFAULT_FACTOR_WEIGHTS.trendWeightPct),
    volumePriceWeightPct: clampWeightPct(options.volumePriceWeightPctUpper, DEFAULT_FACTOR_WEIGHTS.volumePriceWeightPct),
    distanceFromLowWeightPct: clampWeightPct(options.distanceFromLowWeightPctUpper, DEFAULT_FACTOR_WEIGHTS.distanceFromLowWeightPct),
    volatilityTrendWeightPct: clampWeightPct(options.volatilityTrendWeightPctUpper, DEFAULT_FACTOR_WEIGHTS.volatilityTrendWeightPct),
    relativeStrengthWeightPct: clampWeightPct(options.relativeStrengthWeightPctUpper, DEFAULT_FACTOR_WEIGHTS.relativeStrengthWeightPct),
  };
  const scoringConfig = options.scoringConfig ?? DEFAULT_SCORE_STOCK_CONFIG;
  console.log('[backtest] runRandomizedBacktest start', { days, strategyCount, bounds, scoring_config: 'custom' });
  const context = buildBacktestContext(history, days, scoringConfig);
  const batchRunId = `${compactDate().slice(0, 8)}_${compactDate().slice(8)}`;
  const seed = hashString([
    history.as_of_date,
    history.stocks.length,
    days,
    strategyCount,
    bounds.maxHoldDays,
    bounds.maxPositions,
    bounds.stopLossPct,
    bounds.takeProfitPct,
    bounds.positionSizePct,
    bounds.trendWeightPct,
    bounds.volumePriceWeightPct,
    bounds.distanceFromLowWeightPct,
    bounds.volatilityTrendWeightPct,
    bounds.relativeStrengthWeightPct,
  ].join('|'));
  const rng = createRng(seed);
  const results: BacktestResult[] = [];

  for (let index = 0; index < strategyCount; index += 1) {
    const strategy = createT1StrategyConfig({
      maxHoldDays: randomInt(rng, 1, bounds.maxHoldDays),
      maxPositions: randomInt(rng, 1, bounds.maxPositions),
      stopLossPct: -randomInt(rng, 1, bounds.stopLossPct),
      takeProfitPct: randomInt(rng, 1, bounds.takeProfitPct),
      positionSizePct: randomInt(rng, 1, bounds.positionSizePct),
    });
    // 必须给齐每一个权重字段：漏一个会让 applyFactorWeights 里的 NaN 传染到 total_score，
    // 于是所有候选都过不了入场线、整批随机组合零成交（而不是报错）。
    const factorWeights: FactorWeights = normalizeFactorWeights({
      trendWeightPct: randomInt(rng, 1, bounds.trendWeightPct),
      volumePriceWeightPct: randomInt(rng, 1, bounds.volumePriceWeightPct),
      distanceFromLowWeightPct: randomInt(rng, 1, bounds.distanceFromLowWeightPct),
      volatilityTrendWeightPct: randomInt(rng, 1, bounds.volatilityTrendWeightPct),
      relativeStrengthWeightPct: randomInt(rng, 1, bounds.relativeStrengthWeightPct),
    });
    const simulation = simulateBacktest(context, strategy, factorWeights);
    results.push(buildResult(history, context, strategy, simulation, {
      mode: 'random',
      batchSize: strategyCount,
      comboIndex: index + 1,
      batchRunId,
      bounds,
      factorWeights,
      scoringConfig,
    }));
    console.log('[backtest] random combo done', {
      combo_index: index + 1,
      batch_size: strategyCount,
      trend_weight_pct: factorWeights.trendWeightPct,
      volume_price_weight_pct: factorWeights.volumePriceWeightPct,
      distance_from_low_weight_pct: factorWeights.distanceFromLowWeightPct,
      volatility_weight_pct: factorWeights.volatilityTrendWeightPct,
      relative_strength_weight_pct: factorWeights.relativeStrengthWeightPct,
      total_return_pct: results.at(-1)?.summary.total_return_pct,
      run_id: results.at(-1)?.run_id,
    });
  }

  return results;
}

export interface BacktestQuickSummary {
  totalReturnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  totalTrades: number;
}

/** 构建可复用的回测上下文（评分矩阵 + 日历），供参数优化等批量模拟使用。 */
export function prepareBacktestContext(
  history: HistoricalMarketData,
  days: number,
  scoringConfig: ScoreStockConfig = DEFAULT_SCORE_STOCK_CONFIG,
) {
  return buildBacktestContext(history, days, scoringConfig);
}

/** 在已有 context 上快速模拟一组参数，避免重复构建评分矩阵。 */
export function quickSimulateBacktest(
  context: BacktestContext,
  options: {
    maxHoldDays: number;
    maxPositions?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    positionSizePct?: number;
    trendWeightPct?: number;
    volumePriceWeightPct?: number;
    distanceFromLowWeightPct?: number;
    volatilityTrendWeightPct?: number;
    /** backtest-param-optimizer 的 OptimizedStrategyParams 用的是这个短名。 */
    volatilityWeightPct?: number;
    relativeStrengthWeightPct?: number;
  },
): BacktestQuickSummary {
  const strategy = createT1StrategyConfig({
    maxHoldDays: Math.max(1, Math.trunc(options.maxHoldDays)),
    maxPositions: Math.max(1, Math.trunc(options.maxPositions ?? DEFAULT_T1_STRATEGY.maxPositions)),
    stopLossPct: normalizeStopLossPct(options.stopLossPct),
    takeProfitPct: Math.max(1, Math.trunc(options.takeProfitPct ?? DEFAULT_T1_STRATEGY.takeProfitPct)),
    positionSizePct: Math.max(1, Math.trunc(options.positionSizePct ?? DEFAULT_T1_STRATEGY.positionSizePct)),
  });
  const factorWeights = normalizeFactorWeights({
    trendWeightPct: options.trendWeightPct,
    volumePriceWeightPct: options.volumePriceWeightPct,
    distanceFromLowWeightPct: options.distanceFromLowWeightPct,
    // 优化器一直传的是 volatilityWeightPct，而这里只读 volatilityTrendWeightPct，
    // 于是波动率权重被静默丢弃、恒为默认值 —— 两个名字都接受以消除这个断点。
    volatilityTrendWeightPct: options.volatilityTrendWeightPct ?? options.volatilityWeightPct,
    relativeStrengthWeightPct: options.relativeStrengthWeightPct,
  });
  const simulation = simulateBacktest(context, strategy, factorWeights);
  const summary = summarizeSimulation(simulation);
  return {
    totalReturnPct: summary.totalReturnPct,
    winRate: summary.winRate,
    maxDrawdownPct: summary.maxDrawdownPct,
    totalTrades: summary.totalTrades,
  };
}
