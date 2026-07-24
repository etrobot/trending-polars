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

export function runPolarsBacktest(
  history: HistoricalMarketData,
  options: { days: number; maxHoldDays: number },
): BacktestResult {
  const days = Math.min(60, Math.max(5, Math.trunc(options.days || 20)));
  const maxHoldDays = Math.max(1, Math.trunc(options.maxHoldDays || 5));
  const strategy = createT1StrategyConfig({ maxHoldDays });
  const dates = history.calendar.filter((date) => date <= history.as_of_date).slice(-days);
  if (dates.length < 2) throw new Error('历史数据不足，至少需要两个交易日');

  // ---- Vectorized score pre-computation (single Polars pass) ----
  const exactLimitUpDates = limitUpDatesByCode(history);
  const exactLimitUpCodes = limitUpCodesByDate(history);
  const scoreMap = computeBacktestScores(history, dates, exactLimitUpDates);

  const prepared = history.stocks.map(prepareSeries);
  const seriesByCode = new Map(prepared.map((series) => [series.stockCode, series]));
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
      if (sizing) {
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
  const sellTrades = trades.filter((trade) => trade.action === '卖出');
  const sellFrame = pl.DataFrame(sellTrades.map((trade) => ({
    pnl_pct: Number(trade.pnl_pct),
    pnl_amount: Number(trade.pnl_amount ?? 0),
    hold_days: Number(trade.hold_days),
  })));
  const totalReturn = round(cash - INITIAL_CAPITAL, 2);
  const winCount = sellFrame.height ? sellFrame.filter(pl.col('pnl_amount').gt(0)).height : 0;
  const timestamp = formatDateTime();
  const runId = `${compactDate().slice(0, 8)}_${compactDate().slice(8)}`;

  return {
    run_id: runId,
    timestamp,
    date_range: `${dates[0]} → ${finalDate}`,
    max_hold_days: maxHoldDays,
    engine_version: 'historical-t1-v2',
    data_source: history.source,
    methodology: '当日收盘生成信号，下一交易日开盘成交；涨停事实仅使用同花顺 block_top 记录，不从涨跌幅或理论涨停价反推；个股与宽基/中证指数日线按腾讯→新浪→东方财富顺序获取前复权数据，并计入滑点、佣金与卖出印花税。',
    bias_notes: [
      '股票池来自当前可用排行快照，仍可能存在幸存者偏差；交易信号和成交价格不使用未来行情。',
      '缺少 block_top 记录的日期视为“涨停状态未知”，不会用价格幅度补判。',
    ],
    summary: {
      initial_capital: INITIAL_CAPITAL,
      final_capital: round(cash, 2),
      total_return: totalReturn,
      total_return_pct: round(totalReturn / INITIAL_CAPITAL * 100, 2),
      total_trades: trades.length,
      buy_count: trades.length - sellTrades.length,
      sell_count: sellTrades.length,
      win_count: winCount,
      win_rate: sellTrades.length ? round(winCount / sellTrades.length * 100, 1) : 0,
      expire_count: sellTrades.filter((trade) => trade.reason.startsWith('持仓满')).length,
      max_holdings: maxHoldings,
      max_drawdown_pct: drawdownPercent(equityCurve.map((point) => point.total)),
    },
    config: {
      initial_capital: INITIAL_CAPITAL,
      max_hold_days: maxHoldDays,
      max_positions: strategy.maxPositions,
      stop_loss_pct: strategy.stopLossPct,
      take_profit_pct: strategy.takeProfitPct,
      max_positions_per_day: strategy.maxEntriesPerDay,
      position_size_pct: strategy.positionSizePct,
      max_candidates: strategy.maxCandidates,
      slippage_bps: strategy.slippageRate * 10_000,
      commission_bps: strategy.commissionRate * 10_000,
      stamp_tax_bps: strategy.stampTaxRate * 10_000,
    },
    trades,
    equity_curve: equityCurve,
  };
}
