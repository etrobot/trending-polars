import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  deriveEquityCurve,
  evaluatePerformance,
  filterEquityByRange,
  filterTradesByRange,
  isWithinRange,
  splitSample,
  type PerformanceTrade,
} from '../server/metrics/performance.js';
import {
  fromBacktestTrades,
  fromPaperInstructions,
  paperPnlBySellInstruction,
} from '../server/metrics/adapters.js';
import type { BacktestTrade, PaperStrategyInstruction } from '../src/types.js';

function trade(
  date: string,
  side: 'buy' | 'sell',
  price: number,
  shares: number,
  pnlAmount?: number,
): PerformanceTrade {
  return { date, side, price, shares, amount: price * shares, pnlAmount };
}

describe('统一指标模块', () => {
  it('按已平仓交易计算胜率、盈亏比与交易次数', () => {
    const trades = [
      trade('20260102', 'buy', 10, 100),
      trade('20260105', 'sell', 12, 100, 200),
      trade('20260106', 'buy', 20, 100),
      trade('20260109', 'sell', 18, 100, -200),
      trade('20260110', 'buy', 30, 100),
    ];
    const metrics = computeMetrics({ trades, initialCapital: 10000 });
    expect(metrics.tradeCount).toBe(2);
    expect(metrics.winRate).toBe(50);
    expect(metrics.profitFactor).toBe(1);
    // 买入成交计入换手率，未平仓买入不影响胜率分母。
    expect(metrics.turnover).toBe(9000 / 10000);
  });

  it('最大回撤输出为负百分比，夏普按日频年化', () => {
    const equityCurve = [
      { date: '20260102', total: 100 },
      { date: '20260103', total: 120 },
      { date: '20260104', total: 90 },
      { date: '20260105', total: 110 },
    ];
    const metrics = computeMetrics({ trades: [], equityCurve, initialCapital: 100 });
    expect(metrics.maxDrawdown).toBe(-25);
    expect(metrics.sharpe).toBeGreaterThan(0);
    expect(metrics.annualReturn).toBeGreaterThan(0);
  });

  it('无亏损时盈亏比用 999 近似而非 null', () => {
    const metrics = computeMetrics({
      trades: [trade('20260102', 'sell', 10, 100, 50)],
      initialCapital: 10000,
    });
    expect(metrics.profitFactor).toBe(999);
  });

  it('未传入净值曲线时由成交记录推导阶梯曲线', () => {
    const curve = deriveEquityCurve([
      trade('20260102', 'buy', 10, 100),
      trade('20260105', 'sell', 12, 100, 200),
    ], 10000);
    expect(curve).toEqual([
      { date: '20260102', total: 10000 },
      { date: '20260105', total: 10200 },
    ]);
  });

  it('交易次数不足时标记 insufficient', () => {
    const evaluation = evaluatePerformance({
      trades: [trade('20260102', 'sell', 10, 100, 5)],
      initialCapital: 10000,
    }, 20);
    expect(evaluation.insufficient).toBe(true);
    expect(evaluation.minTradeCount).toBe(20);
  });

  it('按交易日切分样本内与样本外', () => {
    const calendar = ['20260102', '20260105', '20260106', '20260107', '20260108'];
    const split = splitSample({ start: '20260102', end: '20260108' }, calendar, 0.6);
    expect(split.inSample).toEqual({ start: '20260102', end: '20260106' });
    expect(split.outOfSample).toEqual({ start: '20260107', end: '20260108' });
  });

  it('区间过滤按闭区间生效', () => {
    const range = { start: '20260103', end: '20260106' };
    expect(isWithinRange('20260103', range)).toBe(true);
    expect(isWithinRange('20260107', range)).toBe(false);
    expect(filterTradesByRange([
      trade('20260102', 'buy', 10, 100),
      trade('20260104', 'buy', 10, 100),
    ], range)).toHaveLength(1);
    expect(filterEquityByRange([
      { date: '20260102', total: 1 },
      { date: '20260104', total: 2 },
    ], range)).toEqual([{ date: '20260104', total: 2 }]);
  });
});

describe('指标适配层', () => {
  it('回测成交按 action 映射买卖方向并取卖出盈亏', () => {
    const backtestTrades: BacktestTrade[] = [
      {
        date: '20260102', stock_code: '600001', stock_name: '甲', action: '买入',
        price: 10, shares: 100, amount: 1000, position_pct: 10, hold_days: 0,
        pnl_pct: 0, reason: '入场',
      },
      {
        date: '20260105', stock_code: '600001', stock_name: '甲', action: '卖出',
        price: 12, shares: 100, amount: 1200, position_pct: 0, hold_days: 3,
        pnl_pct: 20, pnl_amount: 200, reason: '止盈',
      },
    ];
    const trades = fromBacktestTrades(backtestTrades);
    expect(trades[0]).toMatchObject({ side: 'buy', date: '20260102' });
    expect(trades[1]).toMatchObject({ side: 'sell', pnlAmount: 200 });
  });

  it('模拟交易只统计已成交指令并按 FIFO 还原卖出盈亏', () => {
    const instructions: PaperStrategyInstruction[] = [
      {
        id: 'i1', side: 'buy', stock_code: '600001', stock_name: '甲',
        signal_date: '20260102', signal_price: 10, execution_price: 10,
        quantity: 100, status: 'filled', reason: '入场', created_at: '2026-01-02 10:00:00',
      },
      {
        id: 'i2', side: 'buy', stock_code: '600001', stock_name: '甲',
        signal_date: '20260103', signal_price: 11, execution_price: 11,
        quantity: 100, status: 'filled', reason: '加仓', created_at: '2026-01-03 10:00:00',
      },
      {
        id: 'i3', side: 'sell', stock_code: '600001', stock_name: '甲',
        signal_date: '20260106', signal_price: 13, execution_price: 13,
        quantity: 200, status: 'filled', reason: '止盈', created_at: '2026-01-06 10:00:00',
      },
      {
        id: 'i4', side: 'sell', stock_code: '600002', stock_name: '乙',
        signal_date: '20260106', signal_price: 8, execution_price: 8,
        quantity: 100, status: 'skipped', reason: '未成交', created_at: '2026-01-06 10:00:00',
      },
    ];
    const pnlBySell = paperPnlBySellInstruction(instructions);
    expect(pnlBySell.get('i3')).toBeCloseTo((13 - 10) * 100 + (13 - 11) * 100, 6);

    const trades = fromPaperInstructions(instructions, (instruction) => pnlBySell.get(instruction.id));
    expect(trades).toHaveLength(3);
    expect(trades[2]).toMatchObject({ side: 'sell', pnlAmount: 500 });

    const metrics = computeMetrics({ trades, initialCapital: 10000 });
    expect(metrics.tradeCount).toBe(1);
    expect(metrics.winRate).toBe(100);
  });
});
