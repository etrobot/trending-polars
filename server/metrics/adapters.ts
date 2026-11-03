/**
 * 各路径成交记录 → 统一指标输入的适配层（P1）。
 *
 * 回测、参数优化、模拟交易三处的成交数据结构不同，但都必须转换成
 * metrics/performance.ts 的 PerformanceTrade，否则指标口径无法保持一致。
 */

import type { BacktestTrade, EquityPoint, PaperStrategyInstruction } from '../../src/types.js';
import type { PerformanceTrade } from './performance.js';

/** 回测成交记录 → 统一成交记录。 */
export function fromBacktestTrades(trades: readonly BacktestTrade[]): PerformanceTrade[] {
  return trades.map((trade) => ({
    date: trade.date,
    side: trade.action === '买入' ? 'buy' : 'sell',
    price: Number(trade.price ?? 0),
    shares: Number(trade.shares ?? 0),
    amount: Number(trade.amount ?? 0),
    pnlAmount: trade.action === '卖出' ? Number(trade.pnl_amount ?? 0) : undefined,
  }));
}

/** 回测净值曲线 → 统一净值曲线。 */
export function fromBacktestEquity(points: readonly EquityPoint[]): EquityPoint[] {
  return points.map((point) => ({ date: point.date, total: Number(point.total ?? 0) }));
}

/**
 * 模拟交易成交记录 → 统一成交记录。
 *
 * 只有已成交（filled）的指令才计入；成交价缺失时回退到信号价。
 * 模拟交易的卖出盈亏需要结合持仓成本计算，由调用方通过 pnlResolver 注入，
 * 避免这里依赖模拟交易内部状态。
 */
export function fromPaperInstructions(
  instructions: readonly PaperStrategyInstruction[],
  pnlResolver?: (instruction: PaperStrategyInstruction) => number | undefined,
): PerformanceTrade[] {
  return instructions
    .filter((instruction) => instruction.status === 'filled')
    .map((instruction) => {
      const price = Number(instruction.execution_price ?? instruction.signal_price ?? 0);
      const shares = Number(instruction.quantity ?? 0);
      return {
        date: instruction.signal_date,
        side: instruction.side,
        price,
        shares,
        amount: round2(price * shares),
        pnlAmount: instruction.side === 'sell' ? pnlResolver?.(instruction) : undefined,
      };
    });
}

/**
 * 按 FIFO 把已成交的买入指令与卖出指令配对，算出每笔卖出的已实现盈亏。
 *
 * 模拟交易的状态里不保留历史持仓成本（持仓卖出后即从快照消失），因此只能用
 * 成交指令本身做成本还原：买入按成交价建仓队列，卖出按先进先出取成本。
 *
 * @returns 卖出指令 id → 已实现盈亏（净额，不含费用）
 */
export function paperPnlBySellInstruction(
  instructions: readonly PaperStrategyInstruction[],
): Map<string, number> {
  const filled = instructions
    .filter((instruction) => instruction.status === 'filled')
    .slice()
    .sort((left, right) => {
      if (left.signal_date !== right.signal_date) return left.signal_date.localeCompare(right.signal_date);
      if (left.side !== right.side) return left.side === 'buy' ? -1 : 1;
      return 0;
    });

  const costQueue = new Map<string, Array<{ price: number; shares: number }>>();
  const pnlBySell = new Map<string, number>();
  for (const instruction of filled) {
    const code = instruction.stock_code;
    const price = Number(instruction.execution_price ?? instruction.signal_price ?? 0);
    const shares = Number(instruction.quantity ?? 0);
    if (!code || !Number.isFinite(price) || !Number.isFinite(shares) || shares <= 0) continue;
    if (instruction.side === 'buy') {
      const queue = costQueue.get(code) ?? [];
      queue.push({ price, shares });
      costQueue.set(code, queue);
      continue;
    }
    let remaining = shares;
    let cost = 0;
    const queue = costQueue.get(code) ?? [];
    while (remaining > 0 && queue.length) {
      const lot = queue[0];
      const used = Math.min(lot.shares, remaining);
      cost += used * lot.price;
      remaining -= used;
      lot.shares -= used;
      if (lot.shares <= 0) queue.shift();
    }
    if (queue.length) costQueue.set(code, queue);
    else costQueue.delete(code);
    pnlBySell.set(instruction.id, round2((price * shares) - cost));
  }
  return pnlBySell;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
