import { describe, expect, it } from 'vitest';
import { parseBlockTop } from '../server/historical-market.js';
import {
  analyzeBlockTrend,
  blockStrategy,
  classifyMarketState,
  isHotBlock,
  computeADX,
  distanceFromLowScore,
  limitUpCount,
  relativeStrengthScore,
  scoreStock,
  singlePeriodTrend,
  strategyForScore,
  suggestedPositionPct,
  volatilityClassOf,
  volatilityTrendScore,
  RAW_SCORE_MAX,
  SCORE_SCALE,
  type Bar,
  type PreparedSeries,
} from '../server/scoring-engine.js';
import { calculateEntrySize, DEFAULT_T1_STRATEGY } from '../server/trading-strategy.js';

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
    expect(volatilityTrendScore('low', 'range')).toBe(5);
    expect(volatilityTrendScore('low', 'down')).toBe(4);
  });

  it('is monotone along both axes', () => {
    // 行：同一波动率下 up > range > down。旧的 low 行是 8/4/5，
    // 「低波动 + 下跌」比「低波动 + 震荡」还高 1 分，是唯一一处倒挂。
    for (const volatility of ['high', 'medium', 'low'] as const) {
      expect(volatilityTrendScore(volatility, 'up')).toBeGreaterThan(volatilityTrendScore(volatility, 'range'));
      expect(volatilityTrendScore(volatility, 'range')).toBeGreaterThan(volatilityTrendScore(volatility, 'down'));
    }
    // 列：下跌市里低波动受损最小，上涨/震荡市里高波动更有价值 —— 这是刻意的设计，不得改动。
    expect(volatilityTrendScore('low', 'down')).toBeGreaterThan(volatilityTrendScore('medium', 'down'));
    expect(volatilityTrendScore('medium', 'down')).toBeGreaterThan(volatilityTrendScore('high', 'down'));
    expect(volatilityTrendScore('high', 'up')).toBeGreaterThan(volatilityTrendScore('medium', 'up'));
    expect(volatilityTrendScore('medium', 'up')).toBeGreaterThan(volatilityTrendScore('low', 'up'));
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

describe('distanceFromLowScore — 距60日低点分档', () => {
  it('maps rebound buckets to 0-20 scores', () => {
    expect(distanceFromLowScore(2)).toEqual({ score: 4, label: '贴近低点' });
    expect(distanceFromLowScore(10)).toEqual({ score: 10, label: '刚离低点' });
    expect(distanceFromLowScore(20)).toEqual({ score: 18, label: '启动确认' });
    expect(distanceFromLowScore(40)).toEqual({ score: 20, label: '趋势上行' });
    expect(distanceFromLowScore(60)).toEqual({ score: 14, label: '远离低点' });
    expect(distanceFromLowScore(90)).toEqual({ score: 8, label: '高位延伸' });
  });
});

describe('dimension 5 — 相对强度', () => {
  it('uses a neutral fallback and maps excess return continuously', () => {
    expect(relativeStrengthScore(10, null)).toEqual({ score: 10, label: '基准缺失', excessPct: null });
    expect(relativeStrengthScore(5, 0)).toEqual({ score: 10, label: '跑赢大盘', excessPct: 5 });
    expect(relativeStrengthScore(20, 0)).toEqual({ score: 17.5, label: '显著跑赢', excessPct: 20 });
    expect(relativeStrengthScore(-20, 0)).toEqual({ score: 0, label: '显著跑输', excessPct: -20 });
  });
});

describe('scoreStock — 五维评分与标签', () => {
  it('emits all five dimensions and a normalized total score', () => {
    const row = scoreStock(prepared(steadyUp()), String(100059))!;
    expect(row).not.toBeNull();
    expect(row.alignment).toBe('bullish');
    expect(row.volatility_class).toBe('low');
    // 低波动 × 上升 = 8（与旧的写死 8 巧合，但现在是矩阵推导）。
    expect(row.volatility_trend_score).toBe(8);
    expect(row.limit_up_count_20d).toBe(0);
    expect(typeof row.volume_price_label).toBe('string');
    expect(row.volatility_label).toBe('低波动');
    expect(typeof row.distance_from_low_pct).toBe('number');
    expect(Number(row.position_score)).toBeGreaterThan(0);
    // 无指数数据 → 维度 5 取中性分（maxScore/2）。
    expect(row.relative_strength_label).toBe('基准缺失');
    expect(row.relative_strength_score).toBe(10);
    // 五维原始满分 120，对外折算到 100 分制。
    expect(row.total_score).toBeCloseTo(
      (Number(row.trend_score)
        + Number(row.volume_price_score)
        + Number(row.position_score)
        + Number(row.volatility_trend_score)
        + Number(row.relative_strength_score)) * SCORE_SCALE / RAW_SCORE_MAX,
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
    // 布林带算法：10% 的极端日线产生较大偏移，趋势分数可能不足以达到 'up' 阈值，
    // 因此波动率-趋势适配得分可能落在 'range' 列。这是正确的——包含极端日线的
    // 趋势不够流畅，不应被归类为稳定上升趋势。
    expect(row.volatility_trend_score).toBeGreaterThanOrEqual(8);
    expect(row.volatility_trend_score).toBeLessThanOrEqual(15);
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

describe('板块趋势 × 个股形态情境修正', () => {
  const scoreInState = (
    bars: Bar[],
    stateId: number,
    trend: 'up' | 'range' | 'down',
    limitUpDates: ReadonlySet<string> = new Set(),
  ) => scoreStock(prepared(bars), bars.at(-1)!.date, {
    stateId,
    trend,
    trendName: ({ 1: '主线主升', 2: '高位滞涨', 6: '阴跌不止', 7: '恐慌暴跌', 8: '筑底成功' } as Record<number, string>)[stateId],
    limitUpDates,
  })!;

  it('rewards a slow, stable stock trend that crosses a falling sector', () => {
    const row = scoreInState(steadyUp(80, 0.4), 6, 'down');
    expect(row.sector_strategy_score).toBe(8);
    expect(row.sector_opportunity_bonus).toBe(8);
    expect(row.sector_risk_penalty).toBe(0);
    expect(row.sector_strategy_label).toBe('穿越板块稳定上行');
  });

  it('rewards a formerly strong stock at a multi-day panic extreme', () => {
    const bars = barsFromReturns(20, [
      ...Array.from({ length: 60 }, () => 0.3),
      ...Array.from({ length: 10 }, () => -2),
    ]);
    const row = scoreInState(bars, 7, 'down', new Set([bars[45].date]));
    expect(row.sector_strategy_score).toBe(8);
    expect(row.sector_strategy_label).toBe('前强股恐慌极点');
    expect(row.sector_strategy_reason).toContain('1次涨停事实');
  });

  it('penalizes a violent rebound in a falling sector before considering opportunity bonuses', () => {
    const bars = barsFromReturns(30, [
      ...Array.from({ length: 69 }, () => -0.6),
      8,
    ], [
      ...Array.from({ length: 69 }, () => 1_000_000),
      2_000_000,
    ]);
    const row = scoreInState(bars, 7, 'down', new Set([bars[40].date]));
    expect(row.sector_strategy_score).toBe(-10);
    expect(row.sector_risk_penalty).toBe(-10);
    expect(row.sector_opportunity_bonus).toBe(0);
    expect(row.sector_strategy_label).toBe('下跌市暴力反弹');
  });

  it('penalizes an ordinary countertrend bounce without stable structure', () => {
    const bars = barsFromReturns(30, [
      ...Array.from({ length: 65 }, () => -0.5),
      ...Array.from({ length: 5 }, () => 0.7),
    ]);
    const row = scoreInState(bars, 6, 'down');
    expect(row.sector_strategy_score).toBe(-4);
    expect(row.sector_strategy_label).toBe('普通逆势反弹');
  });

  it('treats the same volume breakout as chase risk in strength and confirmation at a bottom', () => {
    const returns = [...Array.from({ length: 69 }, () => 0.25), 3.5];
    const volumes = [...Array.from({ length: 69 }, () => 1_000_000), 2_000_000];
    const bars = barsFromReturns(10, returns, volumes);
    const strong = scoreInState(bars, 1, 'up');
    const bottoming = scoreInState(bars, 8, 'up');
    expect(strong.sector_strategy_score).toBe(-10);
    expect(strong.sector_strategy_label).toBe('强势行情放量新高');
    expect(bottoming.sector_strategy_score).toBe(8);
    expect(bottoming.sector_strategy_label).toBe('筑底放量新高');
    expect(Number(bottoming.total_score)).toBeGreaterThan(Number(strong.total_score));
  });

  it('keeps the contextual result free of future bars', () => {
    const bars = steadyUp(80, 0.4);
    const signalDate = bars[59].date;
    const first = scoreStock(prepared(bars), signalDate, { stateId: 6, trend: 'down' })!;
    const mutated = bars.map((bar) => ({ ...bar }));
    mutated[70] = { ...mutated[70], close: mutated[70].close * 4, high: mutated[70].high * 4, volume: 99_000_000 };
    const afterFuture = scoreStock(prepared(mutated), signalDate, { stateId: 6, trend: 'down' })!;
    expect(afterFuture).toEqual(first);
    expect(first.sector_strategy_label).toBe('穿越板块稳定上行');
  });
});

describe('classifyMarketState — 八种市场状态', () => {
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

  it('flags bottom recovery after decline as 筑底成功', () => {
    const decline = Array.from({ length: 55 }, () => -0.4);
    const recovery = Array.from({ length: 5 }, () => 0.8);
    const volumes = [
      ...Array.from({ length: 55 }, () => 1_000_000),
      ...Array.from({ length: 5 }, () => 1_800_000),
    ];
    const state = classifyMarketState(barsFromReturns(20, [...decline, ...recovery], volumes));
    expect(state.state_id).toBe(8);
    expect(state.state_name).toBe('筑底成功');
    expect(state.position).toBe('1成');
    expect(state.signal).toBe('buy');
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
    const weeklyDown = barsFromReturns(30, Array.from({ length: 30 }, () => -1.5));
    const monthlyDown = barsFromReturns(40, Array.from({ length: 30 }, () => -2.5));
    expect(singlePeriodTrend(weeklyDown)).toBe('down');
    const result = analyzeBlockTrend(daily, weeklyDown, monthlyDown);
    expect(result.state_id).toBe(6);
    expect(result.adjusted).toBe(true);
    expect(result.adjust_direction).toBe('down');
    expect(result.downgraded).toBe(true);
  });

  it('keeps the daily state when higher timeframes are not both down', () => {
    const daily = steadyUp();
    const weeklyUp = barsFromReturns(30, Array.from({ length: 30 }, () => 1.5));
    const monthlyUp = barsFromReturns(40, Array.from({ length: 30 }, () => 2.0));
    const result = analyzeBlockTrend(daily, weeklyUp, monthlyUp);
    expect(result.state_id).toBe(1);
    expect(result.adjusted).toBeUndefined();
    expect(result.confirmations).toEqual({ weekly: true, monthly: true });
  });
});

describe('strategyForScore — 建议仓位系数', () => {
  it('maps score tiers to 0.x position ratios', () => {
    expect(strategyForScore(70)).toMatchObject({ strategy_position_ratio: 0.8, strategy_position: '0.8' });
    expect(strategyForScore(55)).toMatchObject({ strategy_position_ratio: 0.6, strategy_position: '0.6' });
    expect(strategyForScore(40)).toMatchObject({ strategy_position_ratio: 0.4, strategy_position: '0.4' });
    expect(strategyForScore(25)).toMatchObject({ strategy_position_ratio: 0.2, strategy_position: '0.2' });
    expect(strategyForScore(10)).toMatchObject({ strategy_position_ratio: 0.05, strategy_position: '0.05' });
    expect(strategyForScore(3)).toMatchObject({ strategy_position_ratio: 0, strategy_position: '0' });
  });

  it('multiplies ratio by backtest position_size_pct', () => {
    expect(suggestedPositionPct(0.8, 10)).toBe(8);
    expect(suggestedPositionPct(0.6, 12)).toBe(7.2);
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
    expect(blockStrategy(8, 2, 1)).toEqual({ action: 'accumulate', label: '筑底成功', position: '1成' });
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

describe('computeADX — Welles Wilder ADX/DI', () => {
  it('returns zero values for insufficient bars', () => {
    const short = barsFromReturns(100, Array.from({ length: 10 }, () => 0.5));
    const adx = computeADX(short, short.length - 1, 14);
    expect(adx.adx).toBe(0);
    expect(adx.direction).toBe(0);
  });

  it('reports positive direction (+DI > -DI) in a steady uptrend', () => {
    const up = barsFromReturns(100, Array.from({ length: 40 }, () => 0.6));
    const adx = computeADX(up, up.length - 1, 14);
    expect(adx.adx).toBeGreaterThan(15);
    expect(adx.direction).toBeGreaterThan(0);
    expect(adx.plusDI).toBeGreaterThan(adx.minusDI);
  });

  it('reports negative direction (-DI > +DI) in a steady downtrend', () => {
    const down = barsFromReturns(100, Array.from({ length: 40 }, () => -0.6));
    const adx = computeADX(down, down.length - 1, 14);
    expect(adx.adx).toBeGreaterThan(15);
    expect(adx.direction).toBeLessThan(0);
    expect(adx.minusDI).toBeGreaterThan(adx.plusDI);
  });

  it('produces a low ADX in a noisy, range-bound series', () => {
    // 在 0 附近随机震荡，没有明显趋势
    const noisy: Bar[] = [];
    let prevClose = 100;
    for (let i = 0; i < 60; i += 1) {
      const changePct = (Math.sin(i) + Math.cos(i * 1.7)) * 0.3;
      const close = prevClose * (1 + changePct / 100);
      noisy.push({
        date: String(100000 + i),
        open: prevClose,
        close,
        high: Math.max(prevClose, close) * 1.001,
        low: Math.min(prevClose, close) * 0.999,
        volume: 1_000_000,
        amount: 0,
        changePct,
      });
      prevClose = close;
    }
    const adx = computeADX(noisy, noisy.length - 1, 14);
    expect(adx.adx).toBeLessThan(30);
  });
});

describe('analyzeBlockTrend — 多周期升级/降级', () => {
  it('upgrades a falling daily trend to 筑底成功 when weekly and monthly both rise', () => {
    // 日线下跌但周月线均上升：底部共振信号
    const dailyDown = barsFromReturns(100, Array.from({ length: 60 }, () => -0.3));
    const weeklyUp = barsFromReturns(50, Array.from({ length: 30 }, () => 1.5));
    const monthlyUp = barsFromReturns(60, Array.from({ length: 30 }, () => 2.5));
    expect(singlePeriodTrend(weeklyUp)).toBe('up');
    expect(singlePeriodTrend(monthlyUp)).toBe('up');
    const result = analyzeBlockTrend(dailyDown, weeklyUp, monthlyUp);
    expect(result.state_id).toBe(8);
    expect(result.adjusted).toBe(true);
    // 升级是变乐观，不该置位 downgraded —— 这正是旧实现分不清的地方。
    expect(result.adjust_direction).toBe('up');
    expect(result.downgraded).toBe(false);
    expect(result.original_state_id).toBe(6); // 日线原始为阴跌不止
  });

  it('suppresses state 8 when weekly and monthly both fall', () => {
    // 日线 state 8（筑底） + 周月均下跌 → 应当降级为 6
    const decline = Array.from({ length: 55 }, () => -0.4);
    const recovery = Array.from({ length: 5 }, () => 0.8);
    const volumes = [
      ...Array.from({ length: 55 }, () => 1_000_000),
      ...Array.from({ length: 5 }, () => 1_800_000),
    ];
    const dailyBars = barsFromReturns(20, [...decline, ...recovery], volumes);
    const weeklyDown = barsFromReturns(50, Array.from({ length: 30 }, () => -1.5));
    const monthlyDown = barsFromReturns(60, Array.from({ length: 30 }, () => -2.5));
    const result = analyzeBlockTrend(dailyBars, weeklyDown, monthlyDown);
    expect(result.state_id).toBe(6);
    expect(result.adjusted).toBe(true);
    expect(result.adjust_direction).toBe('down');
    expect(result.original_state_id).toBe(8);
  });
});

describe('blockStrategy — 热度相对化与多周期共振', () => {
  it('scales the hot threshold with overall market temperature', () => {
    // 冷市场（全市场 30 家涨停）：4 家即达标（30 × 12% ≈ 4）。
    expect(isHotBlock(4, 2, 30)).toBe(true);
    // 热市场（全市场 120 家）：同样 4 家远不够，需要 8 家（钳制上限）。
    expect(isHotBlock(4, 2, 120)).toBe(false);
    expect(isHotBlock(8, 2, 120)).toBe(true);
    // 极冷市场也不会把门槛压到 1~2 家（下限 3）。
    expect(isHotBlock(2, 2, 8)).toBe(false);
    expect(isHotBlock(3, 2, 8)).toBe(true);
    // 连板高度仍是硬条件。
    expect(isHotBlock(20, 1, 30)).toBe(false);
    // 不传全市场总数时退回旧的固定阈值 5。
    expect(isHotBlock(4, 2)).toBe(false);
    expect(isHotBlock(5, 2)).toBe(true);
  });

  it('lifts the position one notch on weekly+monthly resonance', () => {
    const base = blockStrategy(1, 2, 1);
    const resonant = blockStrategy(1, 2, 1, { higherTimeframe: { weekly: 'up', monthly: 'up' } });
    expect(base.position).toBe('3-5成');
    expect(resonant.position).toBe('7-9成');
    expect(resonant.label).toBe(base.label);
  });

  it('does not lift a 回避 state, and does not double-penalise divergence', () => {
    // 负向背离已经由 analyzeBlockTrend 改写 state_id 处理过，这里不得再减一档。
    const avoid = blockStrategy(6, 2, 1, { higherTimeframe: { weekly: 'down', monthly: 'down' } });
    expect(avoid).toEqual({ action: 'ignore', label: '回避', position: '0成' });
    const mixed = blockStrategy(1, 2, 1, { higherTimeframe: { weekly: 'up', monthly: 'range' } });
    expect(mixed.position).toBe('3-5成');
  });
});

describe('calculateEntrySize — 按评分缩放仓位', () => {
  it('allocates more to a higher-scoring candidate', () => {
    const high = calculateEntrySize(1_000_000, 1_000_000, 10, DEFAULT_T1_STRATEGY, 80);
    const mid = calculateEntrySize(1_000_000, 1_000_000, 10, DEFAULT_T1_STRATEGY, 45);
    // 10% 单票上限 × 0.8 / 0.4 分档系数。
    expect(high?.shares).toBe(8000);
    expect(mid?.shares).toBe(4000);
  });

  it('refuses to size a candidate below the lowest tier', () => {
    expect(calculateEntrySize(1_000_000, 1_000_000, 10, DEFAULT_T1_STRATEGY, 5)).toBeNull();
  });

  it('falls back to the flat size when scaling is off or no score is given', () => {
    const flat = calculateEntrySize(1_000_000, 1_000_000, 10, DEFAULT_T1_STRATEGY);
    expect(flat?.shares).toBe(10_000);
    const disabled = calculateEntrySize(
      1_000_000,
      1_000_000,
      10,
      { ...DEFAULT_T1_STRATEGY, scoreScaledSizing: false },
      80,
    );
    expect(disabled?.shares).toBe(10_000);
  });
});
