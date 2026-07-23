import { describe, expect, it } from 'vitest';
import { parseBlockTop } from '../server/historical-market.js';
import {
  analyzeBlockTrend,
  blockStrategy,
  classifyMarketState,
  limitUpCount,
  scoreStock,
  singlePeriodTrend,
  volatilityClassOf,
  volatilityTrendScore,
  type Bar,
  type PreparedSeries,
} from '../server/scoring-engine.js';

/** 由每日涨跌幅（百分比）构造 Bar 序列；涨停事实另由 block_top 日期集合传入。 */
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

function prepared(bars: Bar[], code = '600001', name = '样本股'): PreparedSeries {
  return { stockCode: code, stockName: name, bars, indexByDate: new Map(bars.map((bar, index) => [bar.date, index])) };
}

const steadyUp = (n = 60, step = 0.6) => barsFromReturns(10, Array.from({ length: n }, () => step));
const steadyDown = (n = 60, step = -0.4) => barsFromReturns(20, Array.from({ length: n }, () => step));

describe('dimension 4 — 波动率-趋势适配矩阵', () => {
  it('maps the ref-doc §4.2 cross matrix exactly', () => {
    expect(volatilityTrendScore('high', 'up')).toBe(15);
    expect(volatilityTrendScore('high', 'range')).toBe(8);
    expect(volatilityTrendScore('high', 'down')).toBe(1);
    expect(volatilityTrendScore('medium', 'up')).toBe(12);
    expect(volatilityTrendScore('medium', 'range')).toBe(6);
    expect(volatilityTrendScore('medium', 'down')).toBe(3);
    expect(volatilityTrendScore('low', 'up')).toBe(8);
    expect(volatilityTrendScore('low', 'range')).toBe(4);
    expect(volatilityTrendScore('low', 'down')).toBe(5);
  });

  it('classifies volatility from 20-day limit-up count', () => {
    expect(volatilityClassOf(0)).toBe('low');
    expect(volatilityClassOf(1)).toBe('medium');
    expect(volatilityClassOf(2)).toBe('medium');
    expect(volatilityClassOf(3)).toBe('high');
    expect(volatilityClassOf(6)).toBe('high');
  });

  it('counts only block_top-confirmed limit-up days within the lookback window', () => {
    const returns = Array.from({ length: 25 }, (_, index) => (index === 22 || index === 24 ? 10 : 0.3));
    const bars = barsFromReturns(10, returns);
    const confirmedDates = new Set([bars[22].date, bars[24].date]);
    expect(limitUpCount(bars, bars.length - 1, confirmedDates)).toBe(2);
    // 即使日涨幅为 +10%，没有 block_top 记录也不能判为涨停。
    expect(limitUpCount(bars, bars.length - 1, new Set())).toBe(0);
  });
});

describe('scoreStock — 四维评分与标签', () => {
  it('replaces the flat 8 with a real volatility-trend score and emits labels', () => {
    const row = scoreStock(prepared(steadyUp()), String(100059))!;
    expect(row).not.toBeNull();
    expect(row.alignment).toBe('bullish');
    expect(row.volatility_class).toBe('low');
    // 低波动 × 上升 = 8（与旧的写死 8 巧合，但现在是矩阵推导）。
    expect(row.volatility_trend_score).toBe(8);
    expect(row.limit_up_count_20d).toBe(0);
    expect(row.position_label).toBe('强势多头');
    expect(typeof row.volume_price_label).toBe('string');
    expect(row.volatility_label).toBe('低波动');
    expect(row.total_score).toBeCloseTo(
      Number(row.trend_score) + Number(row.volume_price_score) + Number(row.position_score) + Number(row.volatility_trend_score),
      1,
    );
  });

  it('scores a high-volatility uptrend at the top of the matrix column', () => {
    const returns = Array.from({ length: 60 }, (_, index) => ([45, 50, 55].includes(index) ? 10 : 0.5));
    const bars = barsFromReturns(10, returns);
    const row = scoreStock(prepared(bars), String(100059), {
      limitUpDates: new Set([bars[45].date, bars[50].date, bars[55].date]),
    })!;
    expect(row.volatility_class).toBe('high');
    expect(row.limit_up_count_20d).toBeGreaterThanOrEqual(3);
    expect(row.volatility_trend_score).toBe(15);
  });

  it('is deterministic and never reads future bars', () => {
    const bars = steadyUp();
    const series = prepared(bars);
    const first = scoreStock(series, String(100039))!;
    const second = scoreStock(series, String(100039))!;
    expect(second).toEqual(first);

    // 篡改信号日之后的 K 线，早前的评分必须原样不变。
    const mutated = bars.map((bar) => ({ ...bar }));
    mutated[50] = { ...mutated[50], close: mutated[50].close * 3, high: mutated[50].close * 3 };
    const afterFuture = scoreStock(prepared(mutated), String(100039))!;
    expect(afterFuture).toEqual(first);
  });

  it('applies the sector uptrend bonus only when sector context is supplied', () => {
    const series = prepared(steadyUp());
    const base = scoreStock(series, String(100059))!;
    const boosted = scoreStock(series, String(100059), { trend: 'up', trendName: '主线主升', stateId: 1 })!;
    expect(Number(boosted.trend_score)).toBeGreaterThanOrEqual(Number(base.trend_score));
    expect(boosted.sector_trend_name).toBe('主线主升');
    expect(boosted.sector_trend_state_id).toBe(1);
  });
});

describe('classifyMarketState — 七种市场状态', () => {
  it('returns 数据不足 with fewer than 20 bars', () => {
    expect(classifyMarketState(steadyUp(10).slice(0, 10)).state_id).toBe(0);
  });

  it('flags a strong rising trend near its high as 主线主升', () => {
    const state = classifyMarketState(steadyUp());
    expect(state.state_id).toBe(1);
    expect(state.trend).toBe('上升');
    expect(state.signal).toBe('buy');
  });

  it('flags a steady decline as 阴跌不止 and a crash as 恐慌暴跌', () => {
    expect(classifyMarketState(steadyDown()).state_id).toBe(6);
    const crash = barsFromReturns(20, [...Array.from({ length: 55 }, () => -0.3), -3, -3, -3, -3, -3]);
    expect(classifyMarketState(crash).state_id).toBe(7);
  });

  it('separates 箱体震荡 from 缩量无序 by volume contraction', () => {
    // 全平序列 → 均线粘合、斜率为 0 → 横盘；再由量能区分 4 与 5。
    const flat = Array.from({ length: 60 }, () => 0);
    expect(classifyMarketState(barsFromReturns(15, flat)).state_id).toBe(4);
    const dryVolumes = Array.from({ length: 60 }, (_, index) => (index >= 55 ? 400_000 : 1_000_000));
    expect(classifyMarketState(barsFromReturns(15, flat, dryVolumes)).state_id).toBe(5);
  });
});

describe('analyzeBlockTrend — 周月线交叉验证', () => {
  it('downgrades a rising daily trend to 阴跌不止 when weekly and monthly both fall', () => {
    const daily = steadyUp();
    const weeklyDown = barsFromReturns(30, Array.from({ length: 12 }, () => -1.5));
    const monthlyDown = barsFromReturns(40, Array.from({ length: 12 }, () => -2.5));
    expect(singlePeriodTrend(weeklyDown)).toBe('down');
    const result = analyzeBlockTrend(daily, weeklyDown, monthlyDown);
    expect(result.state_id).toBe(6);
    expect(result.downgraded).toBe(true);
  });

  it('keeps the daily state when higher timeframes are not both down', () => {
    const daily = steadyUp();
    const weeklyUp = barsFromReturns(30, Array.from({ length: 12 }, () => 1.5));
    const monthlyUp = barsFromReturns(40, Array.from({ length: 12 }, () => 2.0));
    const result = analyzeBlockTrend(daily, weeklyUp, monthlyUp);
    expect(result.state_id).toBe(1);
    expect(result.downgraded).toBeUndefined();
  });
});

describe('blockStrategy — 状态 × 涨停热度矩阵', () => {
  it('splits by hot heat (涨停≥5 且连板≥2)', () => {
    expect(blockStrategy(1, 6, 3)).toEqual({ action: 'accumulate', label: '主线主升', position: '7-9成' });
    expect(blockStrategy(1, 2, 1)).toEqual({ action: 'trade', label: '趋势跟踪', position: '3-5成' });
    expect(blockStrategy(4, 6, 2)).toEqual({ action: 'trade', label: '情绪博弈', position: '3-5成' });
    expect(blockStrategy(4, 1, 1)).toEqual({ action: 'trade', label: '箱体操作', position: '0-3成' });
    expect(blockStrategy(5, 9, 5)).toEqual({ action: 'ignore', label: '休息', position: '0成' });
    expect(blockStrategy(7, 6, 2)).toEqual({ action: 'trade', label: '超跌反弹', position: '0-1成' });
    expect(blockStrategy(7, 1, 1)).toEqual({ action: 'ignore', label: '回避', position: '0成' });
  });
});

describe('parseBlockTop — 同花顺涨停板块解析', () => {
  const fixture = JSON.stringify({
    status_code: 0,
    data: [
      {
        code: '885641',
        name: '风电',
        change: -0.59,
        limit_up_num: 10,
        continuous_plate_num: 6,
        stock_list: [
          { code: '603988', name: '中电电机', continue_num: 1, reason_type: '黄金+电机', change_rate: 10.007, latest: 15.61, is_st: 0 },
          { code: 'BAD', name: '脏数据', continue_num: 2 },
        ],
      },
      { name: '缺代码块', limit_up_num: 3, stock_list: [] },
    ],
  });

  it('maps the real THS shape and skips malformed rows', () => {
    const blocks = parseBlockTop(fixture);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toMatchObject({ code: '885641', name: '风电', change: -0.59, limit_up_num: 10, continuous_plate_num: 6 });
    expect(block.stock_list).toHaveLength(1);
    expect(block.stock_list[0]).toEqual({
      code: '603988',
      name: '中电电机',
      continue_num: 1,
      reason_type: '黄金+电机',
      change_rate: 10.007,
      latest: 15.61,
      is_st: false,
    });
  });

  it('returns an empty array for invalid or empty payloads', () => {
    expect(parseBlockTop('not json')).toEqual([]);
    expect(parseBlockTop({ data: 'nope' })).toEqual([]);
    expect(parseBlockTop({})).toEqual([]);
  });
});
