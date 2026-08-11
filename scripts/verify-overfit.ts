/**
 * 过拟合验证脚本：
 *   1. 把同一段历史切成前/中/后三个窗口，跑当前方案，看收益是否稳定
 *   2. 在最末窗口跑 100 组随机参数组合，看当前方案在分布里的位置
 *
 * 用法（项目根目录）：
 *   pnpm tsx scripts/verify-overfit.ts
 */
import { historicalFixture } from '../tests/historical-fixture.ts';
import { runPolarsBacktest, runRandomizedBacktest, DEFAULT_FACTOR_WEIGHTS } from '../server/backtest-engine.ts';

function fmt(v: number): string {
  return v.toFixed(2).padStart(8);
}

function summarize(label: string, result: { summary: { total_return_pct: number; max_drawdown_pct?: number; win_rate: number; total_trades: number }; date_range: string }): void {
  const s = result.summary;
  console.log(`  ${label.padEnd(20)} 收益=${fmt(s.total_return_pct)}%  最大回撤=${fmt(s.max_drawdown_pct ?? 0)}%  胜率=${fmt(s.win_rate)}%  交易=${String(s.total_trades).padStart(3)}  范围=${result.date_range}`);
}

interface SlicedHistory {
  [key: string]: unknown;
  as_of_date: string;
  calendar: string[];
  stocks: Array<{ stock_code: string; stock_name: string; bars: Array<[string, ...number[]]> }>;
}

function sliceHistory(history: any, startIndex: number, days: number): SlicedHistory {
  const cal = history.calendar;
  const end = Math.min(cal.length, startIndex + days);
  const start = Math.max(0, startIndex);
  const slicedCal = cal.slice(start, end);
  if (slicedCal.length < 5) throw new Error(`窗口太短：只有 ${slicedCal.length} 个交易日`);
  const asOf = slicedCal[slicedCal.length - 1];
  return {
    ...history,
    as_of_date: asOf,
    calendar: slicedCal,
    stocks: history.stocks.map((stock: any) => ({
      ...stock,
      bars: stock.bars.filter((b: any) => slicedCal.includes(b[0])),
    })),
  } as SlicedHistory;
}

console.log('='.repeat(72));
console.log('过拟合验证：当前方案在多窗口 + 随机参数下的稳定性');
console.log('='.repeat(72));
console.log();

const base = historicalFixture('20260722');
console.log(`样本：${String(base.stocks.length)} 只股票，${String(base.calendar.length)} 个交易日，as_of_date=${base.as_of_date}`);
console.log();

// ---- 阶段 1：同一段历史切成 前/中/后 三段，跑当前默认参数 ----
const windows = [
  { label: '前段 (D0-D59)',   startIndex: 0,  days: 60 },
  { label: '中段 (D15-D74)',  startIndex: 15, days: 60 },
  { label: '后段 (D30-D89)',  startIndex: 30, days: 60 },
];

console.log('-'.repeat(72));
console.log('阶段 1：当前默认方案在三段窗口上的表现');
console.log('-'.repeat(72));
const windowReturns: number[] = [];
for (const w of windows) {
  const sliced = sliceHistory(base, w.startIndex, w.days);
  const result = runPolarsBacktest(sliced as any, {
    days: w.days,
    maxHoldDays: 5,
    maxPositions: 10,
    positionSizePct: 10,
    takeProfitPct: 15,
    stopLossPct: 5,
    ...DEFAULT_FACTOR_WEIGHTS,
  });
  summarize(w.label, result);
  windowReturns.push(result.summary.total_return_pct);
}
console.log();

const mean = windowReturns.reduce((a, b) => a + b, 0) / windowReturns.length;
const variance = windowReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / windowReturns.length;
const std = Math.sqrt(variance);
const cv = mean !== 0 ? Math.abs(std / mean) : 0;
console.log(`  窗口均值=${fmt(mean)}%   标准差=${fmt(std)}%   变异系数=${fmt(cv)}`);
console.log(`  → 变异系数 > 0.5 视为策略对窗口敏感（过拟合风险信号之一）`);
console.log();

// ---- 阶段 2：在最末窗口跑 100 组随机参数，看当前方案在分布里的位置 ----
const lastWindow = windows[windows.length - 1];
const lastSliced = sliceHistory(base, lastWindow.startIndex, lastWindow.days);
console.log('-'.repeat(72));
console.log(`阶段 2：${lastWindow.label} 上 100 组随机参数 vs 当前方案`);
console.log('-'.repeat(72));

const randomResults = runRandomizedBacktest(lastSliced as any, {
  days: lastWindow.days,
  strategyCount: 100,
  maxHoldDaysUpper: 10,
  maxPositionsUpper: 15,
  positionSizePctUpper: 20,
  takeProfitPctUpper: 25,
  stopLossPctUpper: 10,
  trendWeightPctUpper: 200,
  volumePriceWeightPctUpper: 200,
  distanceFromLowWeightPctUpper: 200,
  volatilityTrendWeightPctUpper: 200,
  relativeStrengthWeightPctUpper: 200,
});

const randomReturns = randomResults.map((r) => r.summary.total_return_pct).sort((a, b) => a - b);
const current = runPolarsBacktest(lastSliced as any, {
  days: lastWindow.days,
  maxHoldDays: 5,
  maxPositions: 10,
  positionSizePct: 10,
  takeProfitPct: 15,
  stopLossPct: 5,
  ...DEFAULT_FACTOR_WEIGHTS,
});
const currentReturn = current.summary.total_return_pct;

const quantile = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))];
const q25 = quantile(randomReturns, 0.25);
const q50 = quantile(randomReturns, 0.5);
const q75 = quantile(randomReturns, 0.75);
const q90 = quantile(randomReturns, 0.9);
const q99 = quantile(randomReturns, 0.99);

console.log(`  随机参数分布（100 组，${lastWindow.label}）：`);
console.log(`    最小 = ${fmt(randomReturns[0])}%`);
console.log(`    P25  = ${fmt(q25)}%`);
console.log(`    P50  = ${fmt(q50)}%`);
console.log(`    P75  = ${fmt(q75)}%`);
console.log(`    P90  = ${fmt(q90)}%`);
console.log(`    P99  = ${fmt(q99)}%`);
console.log(`    最大 = ${fmt(randomReturns[randomReturns.length - 1])}%`);
console.log();

const rank = randomReturns.filter((r) => r < currentReturn).length;
const percentile = rank / randomReturns.length * 100;
console.log(`  当前方案：${fmt(currentReturn)}%  →  在 100 组随机参数中超过 ${String(rank)} 组（百分位 ${percentile.toFixed(0)}%）`);
console.log();

// 直方图（10 个桶）
const minR = randomReturns[0];
const maxR = randomReturns[randomReturns.length - 1];
const BUCKETS = 10;
const buckets = new Array<number>(BUCKETS).fill(0);
const range = maxR - minR || 1;
for (const r of randomReturns) {
  const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor((r - minR) / range * BUCKETS)));
  buckets[idx] += 1;
}
console.log('  随机参数收益分布：');
for (let i = 0; i < BUCKETS; i += 1) {
  const lo = minR + range * i / BUCKETS;
  const hi = minR + range * (i + 1) / BUCKETS;
  const bar = '#'.repeat(buckets[i]);
  const inBucket = currentReturn >= lo && currentReturn < hi;
  const inLastBucket = i === BUCKETS - 1 && currentReturn === maxR;
  const marker = inBucket || inLastBucket ? ' ← 当前方案' : '';
  console.log(`    [${fmt(lo)}% , ${fmt(hi)}%)  ${bar} (${String(buckets[i])})${marker}`);
}
console.log();

// ---- 结论 ----
console.log('='.repeat(72));
console.log('结论');
console.log('='.repeat(72));
const windowStable = cv < 0.5;
const currentInTail = percentile >= 90;
if (windowStable && !currentInTail) {
  console.log('  [ok] 跨窗口稳定，且当前方案未明显跑赢随机分布 → 不像过拟合');
} else if (!windowStable && !currentInTail) {
  console.log(`  [warn] 跨窗口不稳定（CV=${cv.toFixed(2)}），但绝对收益并非异常高`);
  console.log('         → 建议在更多窗口上验证，或调低参数敏感度');
} else if (windowStable && currentInTail) {
  console.log('  [warn] 跨窗口稳定但当前方案明显跑赢随机分布');
  console.log('         → 可能真有 alpha，也可能是因为随机参数范围窄、没覆盖到当前方案的最优邻域');
} else {
  console.log('  [risk] 跨窗口不稳定 + 当前方案在分布尾部 → 高概率过拟合');
}
console.log();
console.log('  注意：');
console.log('  1. 上述结论基于测试 fixture（4 只合成股），不是真实 A 股数据；');
console.log('  2. 要给出对真实回测 230%/半年 的最终结论，需要在 server/runtime/');
console.log('     有完整历史快照后，把本脚本里的 historicalFixture 换成 store.getHistoricalMarket()。');
