import { describe, expect, it } from 'vitest';
import { benchmarkReturns, computeBacktestScores } from '../server/backtest-scoring.js';
import {
  computeADX,
  classifyMarketState,
  compareByScore,
  DEFAULT_SCORE_STOCK_CONFIG,
  prepareSeries,
  scoreStock,
  singlePeriodTrend,
  DEFAULT_MARKET_STATE_THRESHOLDS,
  MIN_HIGHER_TIMEFRAME_BARS,
  type Bar,
} from '../server/scoring-engine.js';
import type { RankingRow } from '../src/types.js';
import { historicalFixture } from './historical-fixture.js';

/** 由每日涨跌幅构造 Bar 序列。 */
function barsFromReturns(startPrice: number, returns: number[], volumes?: number[]): Bar[] {
  const bars: Bar[] = [];
  let previousClose = startPrice;
  for (let index = 0; index < returns.length; index += 1) {
    const changePct = returns[index];
    const close = previousClose * (1 + changePct / 100);
    const open = previousClose;
    bars.push({
      date: String(100000 + index),
      open: Number(open.toFixed(4)),
      close: Number(close.toFixed(4)),
      high: Number((Math.max(open, close) * 1.004).toFixed(4)),
      low: Number((Math.min(open, close) * 0.996).toFixed(4)),
      volume: volumes?.[index] ?? 1_000_000,
      amount: 0,
      changePct: Number(changePct.toFixed(2)),
    });
    previousClose = close;
  }
  return bars;
}

describe('实盘 scoreStock 与向量化 computeBacktestScores 口径一致', () => {
  // 这两条路径各自实现了同一套五维评分，历史上已经漂移过：
  //   1. 向量化路径漏了 trendBonus 的死区判断（trendStrengthThreshold 形同虚设）；
  //   2. 实盘路径在拿不到板块状态时用个股 alignment 冒充板块趋势，白拿 ±4 板块分。
  //   3. 相对强度维度必须读取同一条基准收益曲线，不能一边给真实分、一边给中性分。
  // 任何一处改动只落到单边，这个测试就会红。
  it('produces identical five-dimension scores for every stock on every date', () => {
    const history = historicalFixture();
    const dates = history.calendar.slice(-5);
    const limitUpDates = new Map<string, Set<string>>();
    const matrix = computeBacktestScores(history, dates, limitUpDates);
    const benchmarkByDate = benchmarkReturns(history, DEFAULT_SCORE_STOCK_CONFIG.relativeStrength.lookback);

    for (const date of dates) {
      const vectorized = new Map((matrix.get(date) ?? []).map((row) => [row.stock_code, row]));
      expect(vectorized.size).toBeGreaterThan(0);
      for (const stock of history.stocks) {
        // 无板块归属：向量化路径 sector_state_id=0，实盘路径必须同样给 sectorBonus=0。
        const live = scoreStock(prepareSeries(stock), date, {
          benchmarkReturnPct: benchmarkByDate.get(date),
        });
        const vector = vectorized.get(stock.stock_code);
        if (!live || !vector) {
          expect(live == null && vector == null).toBe(true);
          continue;
        }
        const label = `${stock.stock_code}@${date}`;
        expect(`${label} trend=${vector.trend_score}`).toBe(`${label} trend=${live.trend_score}`);
        expect(`${label} vp=${vector.volume_price_score}`).toBe(`${label} vp=${live.volume_price_score}`);
        expect(`${label} pos=${vector.position_score}`).toBe(`${label} pos=${live.position_score}`);
        expect(`${label} vol=${vector.volatility_trend_score}`).toBe(`${label} vol=${live.volatility_trend_score}`);
        expect(`${label} rs=${vector.relative_strength_score}`).toBe(`${label} rs=${live.relative_strength_score}`);
        expect(`${label} rsLabel=${vector.relative_strength_label}`).toBe(`${label} rsLabel=${live.relative_strength_label}`);
        expect(`${label} rsPct=${vector.relative_strength_pct}`).toBe(`${label} rsPct=${live.relative_strength_pct}`);
        expect(`${label} total=${vector.total_score}`).toBe(`${label} total=${live.total_score}`);
      }
    }
  });

  it('keeps the trend-strength dead zone on both paths', () => {
    // 斜率落在 ±trendStrengthThreshold 之内时 trendBonus 必须为 0（而不是线性给分）。
    const history = historicalFixture();
    const flat = history.calendar.map((_, index) => index);
    const flatStock = {
      stock_code: '600009',
      stock_name: '零斜率样本',
      bars: history.calendar.map((date, index): [string, number, number, number, number, number, number, number] => [
        date, 10, 10, 10.02, 9.98, 1_000_000, 10_000_000, 0,
      ]),
    };
    expect(flat.length).toBeGreaterThan(20);
    const scoped = { ...history, stocks: [flatStock] };
    const date = history.calendar.at(-1)!;
    const live = scoreStock(prepareSeries(flatStock), date, {
      benchmarkReturnPct: benchmarkReturns(scoped, DEFAULT_SCORE_STOCK_CONFIG.relativeStrength.lookback).get(date),
    })!;
    const vector = (computeBacktestScores(scoped, [date], new Map()).get(date) ?? [])[0];
    expect(live.trend_strength).toBe(0);
    expect(vector.trend_score).toBe(live.trend_score);
  });
});

describe('computeADX — 预热保护', () => {
  it('marks the result cold until period*2 bars are available', () => {
    const rising = (n: number) => barsFromReturns(100, Array.from({ length: n }, () => 0.6));
    expect(computeADX(rising(20), 19, 14).warm).toBe(false);
    expect(computeADX(rising(27), 26, 14).warm).toBe(false);
    expect(computeADX(rising(28), 27, 14).warm).toBe(true);
  });

  it('reports adx=0 rather than a noisy value while cold', () => {
    const bars = barsFromReturns(100, Array.from({ length: 22 }, (_, i) => (i % 2 ? 1.2 : -0.9)));
    const adx = computeADX(bars, bars.length - 1, 14);
    expect(adx.warm).toBe(false);
    expect(adx.adx).toBe(0);
  });

  it('is stable across history lengths once warm (Wilder seed)', () => {
    // 同一根末 K 线，喂入不同长度历史。种子改为「前 period 个 DX 的算术平均」后，
    // 预热完成的窗口之间应当收敛，而不是像旧实现那样从 3.7 摆到 38.8 并翻转方向。
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const closes = [100];
    for (let i = 1; i < 200; i += 1) closes.push(closes[i - 1] * (1 + (rnd() - 0.48) * 0.03));
    const full: Bar[] = closes.map((c, i) => ({
      date: String(20240101 + i),
      open: c,
      close: c,
      high: c * 1.012,
      low: c * 0.988,
      volume: 1000,
      amount: 0,
      changePct: i ? (c / closes[i - 1] - 1) * 100 : 0,
    }));
    const values = [80, 120, 160, 200].map((win) => {
      const slice = full.slice(full.length - win);
      const result = computeADX(slice, slice.length - 1, 14);
      expect(result.warm).toBe(true);
      return result;
    });
    const spread = Math.max(...values.map((v) => v.adx)) - Math.min(...values.map((v) => v.adx));
    expect(spread).toBeLessThan(6);
    // 方向不得因窗口长度而翻转符号。
    const signs = new Set(values.map((v) => Math.sign(v.direction)));
    expect(signs.size).toBe(1);
  });

  it('does not let a cold ADX veto a clear slope-based trend', () => {
    // 只有 22 根 K 线（ADX 未预热）的强势上涨，不应被压成震荡市。
    const short = barsFromReturns(10, Array.from({ length: 22 }, () => 1.0));
    const state = classifyMarketState(short);
    expect(computeADX(short, short.length - 1, 14).warm).toBe(false);
    expect(state.trend).toBe('上升');
  });
});

describe('singlePeriodTrend — 周/月线共振门槛', () => {
  it('refuses to call a direction below the ADX warm-up length', () => {
    const up = (n: number) => barsFromReturns(30, Array.from({ length: n }, () => 1.5));
    expect(singlePeriodTrend(up(MIN_HIGHER_TIMEFRAME_BARS - 1))).toBe('range');
    expect(singlePeriodTrend(up(MIN_HIGHER_TIMEFRAME_BARS))).toBe('up');
  });
});

describe('classifyMarketState — 筑底成功需结构性确认', () => {
  const decline = Array.from({ length: 55 }, () => -0.4);

  it('still recognises a genuine bottom (higher low + MA5 reclaimed)', () => {
    const volumes = [
      ...Array.from({ length: 55 }, () => 1_000_000),
      ...Array.from({ length: 5 }, () => 1_800_000),
    ];
    const bars = barsFromReturns(20, [...decline, ...Array.from({ length: 5 }, () => 0.8)], volumes);
    expect(classifyMarketState(bars).state_id).toBe(8);
  });

  it('rejects a dead-cat bounce that fails the confirmations', () => {
    // 持续下跌中一根放量长阳把 5 日涨幅拉进 2~8%，但均线结构、低点位置全无转折。
    const tail = [-1.2, -1.1, -1.3, -0.9, 8.5];
    const volumes = [
      ...Array.from({ length: 55 }, () => 1_000_000),
      ...Array.from({ length: 5 }, () => 1_900_000),
    ];
    const bars = barsFromReturns(20, [...decline, ...tail], volumes);
    // 这根长阳同时点亮了两项动量证据（收盘站上 MA5、-DI 收敛），
    // 所以只靠「任意 2 项」是拦不住的 —— 必须靠结构类证据（MA5 掉头 / 低点抬高）为 0 来否掉。
    const guarded = classifyMarketState(bars);
    expect(guarded.state_id).not.toBe(8);
    expect(guarded.trend).toBe('下跌');
  });
});

describe('compareByScore — 并列不再偏向小代码', () => {
  it('breaks ties on a continuous factor instead of stock_code', () => {
    const rows = [
      { stock_code: '600900', total_score: 50, trend_strength: 0.02 },
      { stock_code: '000001', total_score: 50, trend_strength: 0.01 },
    ] as unknown as RankingRow[];
    const sorted = [...rows].sort(compareByScore);
    // 旧实现会把 000001 排前（纯代码序）；现在按 trend_strength 决定。
    expect(sorted[0].stock_code).toBe('600900');
  });

  it('remains deterministic when the continuous factor also ties', () => {
    const rows = [
      { stock_code: '600900', total_score: 50, trend_strength: 0.01 },
      { stock_code: '000001', total_score: 50, trend_strength: 0.01 },
    ] as unknown as RankingRow[];
    expect([...rows].sort(compareByScore).map((row) => row.stock_code)).toEqual(['000001', '600900']);
  });
});
