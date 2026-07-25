import pl from 'nodejs-polars';
import type { BacktestResult, BacktestTrade, EquityPoint, RankingRow } from '../src/types.js';
import { computeBacktestScores } from './backtest-scoring.js';
import { compactDate, formatDateTime, round } from './format.js';
import type { HistoricalMarketData } from './historical-market.js';
import { prepareSeries, scoreStock, type PreparedSeries } from './scoring-engine.js';
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
  strategyLabel: string;
  signalDate: string;
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

interface BacktestRunMeta {
  mode: 'current' | 'random';
  batchSize?: number;
  comboIndex?: number;
  batchRunId?: string;
  bounds?: {
    maxHoldDays: number;
    maxPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
    positionSizePct: number;
  };
}

const INITIAL_CAPITAL = 100_000;

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

function trendAxisFromState(stateId: number | undefined, alignment: string | undefined): 'up' | 'range' | 'down' {
  if (stateId != null && [1, 2, 3].includes(stateId)) return 'up';
  if (stateId != null && [6, 7].includes(stateId)) return 'down';
  if (stateId != null && [4, 5].includes(stateId)) return 'range';
  return alignment === 'bullish' ? 'up' : alignment === 'bearish' ? 'down' : 'range';
}

/** Build the complete as-of-date cross section from persisted K lines. */
export function historicalCrossSectionRankings(
  history: HistoricalMarketData,
  date: string,
  previousRows: RankingRow[] = [],
): RankingRow[] {
  const targetDate = date.replaceAll('-', '').slice(0, 8);
  const previousByCode = new Map(previousRows.map((row) => [row.stock_code, row]));
  const exactLimitUpDates = limitUpDatesByCode(history);
  const scored = history.stocks.flatMap((stock): RankingRow[] => {
    const previous = previousByCode.get(stock.stock_code);
    const row = scoreStock(prepareSeries(stock), targetDate, {
      trend: trendAxisFromState(previous?.sector_trend_state_id, previous?.alignment),
      trendName: previous?.sector_trend_name,
      stateId: previous?.sector_trend_state_id,
      code: previous?.sector_code,
      name: previous?.sector_name,
      limitUpDates: exactLimitUpDates.get(stock.stock_code),
    });
    if (!row) return [];
    return [{
      ...previous,
      ...row,
      continue_num: previous?.continue_num,
      reason_info: previous?.reason_info,
    }];
  });
  return scored
    .sort((left, right) => right.total_score - left.total_score || left.stock_code.localeCompare(right.stock_code))
    .map((row, index) => ({ ...row, rank: index + 1 }));
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

function buildBacktestContext(history: HistoricalMarketData, days: number): BacktestContext {
  const dates = history.calendar.filter((date) => date <= history.as_of_date).slice(-days);
  if (dates.length < 2) throw new Error('历史数据不足，至少需要两个交易日');
  const exactLimitUpDates = limitUpDatesByCode(history);
  const prepared = history.stocks.map(prepareSeries);
  return {
    dates,
    exactLimitUpCodes: limitUpCodesByDate(history),
    scoreMap: computeBacktestScores(history, dates, exactLimitUpDates),
    prepared,
    seriesByCode: new Map(prepared.map((series) => [series.stockCode, series] as const)),
  };
}

function simulateBacktest(context: BacktestContext, strategy: ReturnType<typeof createT1StrategyConfig>): SimulatedBacktest {
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
      const sizing = calculateEntrySize(cash, INITIAL_CAPITAL, fillPrice, strategy);
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
        reason: `信号日${order.signalDate} 排名#${order.rank} ${order.strategyLabel} 次日开盘`,
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
      const dayScores = scoreMap.get(date) ?? [];
      pendingEntries = rankEntryCandidates(dayScores, new Set(), DEFAULT_T1_STRATEGY.maxCandidates)
        .filter((candidate) => !heldOrOrdered.has(candidate.stock_code))
        .slice(0, Math.min(strategy.maxEntriesPerDay, availableSlots))
        .map((candidate) => ({
          stockCode: candidate.stock_code,
          stockName: candidate.stock_name,
          rank: candidate.rank,
          strategyLabel: candidate.strategy_label,
          signalDate: date,
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
      slippage_bps: strategy.slippageRate * 10_000,
      commission_bps: strategy.commissionRate * 10_000,
      stamp_tax_bps: strategy.stampTaxRate * 10_000,
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
  },
): BacktestResult {
  const days = Math.min(60, Math.max(5, Math.trunc(options.days || 20)));
  const strategy = createT1StrategyConfig({
    maxHoldDays: Math.max(1, Math.trunc(options.maxHoldDays || 5)),
    maxPositions: Math.max(1, Math.trunc(options.maxPositions ?? DEFAULT_T1_STRATEGY.maxPositions)),
    stopLossPct: normalizeStopLossPct(options.stopLossPct),
    takeProfitPct: Math.max(1, Math.trunc(options.takeProfitPct ?? DEFAULT_T1_STRATEGY.takeProfitPct)),
    positionSizePct: Math.max(1, Math.trunc(options.positionSizePct ?? DEFAULT_T1_STRATEGY.positionSizePct)),
  });
  console.log('[backtest] runPolarsBacktest current scheme', {
    days,
    maxHoldDays: strategy.maxHoldDays,
    maxPositions: strategy.maxPositions,
    positionSizePct: strategy.positionSizePct,
    takeProfitPct: strategy.takeProfitPct,
    stopLossPct: strategy.stopLossPct,
  });
  const context = buildBacktestContext(history, days);
  const simulation = simulateBacktest(context, strategy);
  return buildResult(history, context, strategy, simulation, {
    mode: 'current',
    batchSize: 1,
    comboIndex: 1,
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
  },
): BacktestResult[] {
  const days = Math.min(60, Math.max(5, Math.trunc(options.days || 20)));
  const strategyCount = Math.min(200, Math.max(1, Math.trunc(options.strategyCount || 20)));
  const bounds = {
    maxHoldDays: Math.min(60, Math.max(1, Math.trunc(options.maxHoldDaysUpper || DEFAULT_T1_STRATEGY.maxHoldDays))),
    maxPositions: Math.min(20, Math.max(1, Math.trunc(options.maxPositionsUpper || DEFAULT_T1_STRATEGY.maxPositions))),
    stopLossPct: Math.min(30, Math.max(1, Math.trunc(options.stopLossPctUpper || Math.abs(DEFAULT_T1_STRATEGY.stopLossPct)))),
    takeProfitPct: Math.min(60, Math.max(1, Math.trunc(options.takeProfitPctUpper || DEFAULT_T1_STRATEGY.takeProfitPct))),
    positionSizePct: Math.min(100, Math.max(1, Math.trunc(options.positionSizePctUpper || DEFAULT_T1_STRATEGY.positionSizePct))),
  };
  console.log('[backtest] runRandomizedBacktest start', { days, strategyCount, bounds });
  const context = buildBacktestContext(history, days);
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
    const simulation = simulateBacktest(context, strategy);
    results.push(buildResult(history, context, strategy, simulation, {
      mode: 'random',
      batchSize: strategyCount,
      comboIndex: index + 1,
      batchRunId,
      bounds,
    }));
    console.log('[backtest] random combo done', {
      combo_index: index + 1,
      batch_size: strategyCount,
      total_return_pct: results.at(-1)?.summary.total_return_pct,
      run_id: results.at(-1)?.run_id,
    });
  }

  return results;
}
