import { describe, expect, it } from 'vitest';
import {
  buildRotationScoreMap,
  buildSectorRotation,
  computeEntryMetrics,
  entryLevelOf,
  momentumTagOf,
  scoreSectorEntry,
  trendAxisFromEntryScore,
  type BlockPricePoint,
} from '../server/sector-rotation.js';

function point(code: string, date: string, close: number, high = close, low = close): BlockPricePoint {
  return {
    block_code: code,
    block_name: code === '881001' ? '行业A' : '概念B',
    date,
    open: close,
    high: high,
    low: low,
    close,
  };
}

describe('momentumTagOf', () => {
  it('今年上涨时按比值分档', () => {
    expect(momentumTagOf(1.2, 24, 20)).toBe('资金正关注');
    expect(momentumTagOf(0.5, 10, 20)).toBe('稳定');
    expect(momentumTagOf(-0.2, -4, 20)).toBe('交易平稳');
    expect(momentumTagOf(-1.5, -30, 20)).toBe('反转发生中');
  });

  it('今年下跌时区分阴跌与加速下跌，而不是稳定', () => {
    expect(momentumTagOf(0.5, -10, -20)).toBe('阴跌');
    expect(momentumTagOf(1.4, -28, -20)).toBe('加速下跌');
    expect(momentumTagOf(-0.3, 6, -20)).toBe('交易平稳');
    expect(momentumTagOf(-1.6, 32, -20)).toBe('反转发生中');
  });

  it('分母过小或数据缺失时给出保护标记', () => {
    expect(momentumTagOf(0.9, 0.45, 0.5)).toBe('基数过小');
    expect(momentumTagOf(null, null, 20)).toBe('数据不足');
  });
});

describe('entryLevelOf', () => {
  it('按分数分档', () => {
    expect(entryLevelOf(80)).toBe('平稳介入');
    expect(entryLevelOf(65)).toBe('可关注');
    expect(entryLevelOf(50)).toBe('观察');
    expect(entryLevelOf(30)).toBe('回避');
  });
});

describe('scoreSectorEntry', () => {
  it('多头排列 + 低波动 + 资金关注时满分', () => {
    expect(scoreSectorEntry({
      changePct: 15,
      tag: '资金正关注',
      close: 12,
      ma3: 11.5,
      ma5: 11,
      ma10: 10,
      ma5SlopePct: 1.2,
      avgAmplitudePct: 1.5,
    })).toBe(100);
  });

  it('破位下跌时低分', () => {
    expect(scoreSectorEntry({
      changePct: -20,
      tag: '反转发生中',
      close: 9,
      ma3: 10,
      ma5: 10.5,
      ma10: 11,
      ma5SlopePct: -1.5,
      avgAmplitudePct: 6,
    })).toBe(3);
  });
});

describe('buildSectorRotation', () => {
  const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
  const rows = [
    ...dates.map((date, index) => point('881001', date, 10 + index)),
    ...dates.map((date, index) => point('885001', date, 20 + index)),
  ];

  it('只保留行业板块（881xxx），概念板块不参与', () => {
    const result = buildSectorRotation(rows, 2026);
    expect(result.sectors.map((sector) => sector.code)).toEqual(['881001']);
    expect(result.dates).toEqual(dates);
  });

  it('输出 YTD、近一周蜡烛与均线字段', () => {
    const [sector] = buildSectorRotation(rows, 2026).sectors;
    expect(sector.changePct).toBe(40);
    expect(sector.candles).toHaveLength(5);
    expect(sector.candles.at(-1)?.ma5).toBe(12);
    expect(sector.ma10).toBeNull();
    expect(sector.recentChangePct).toBeNull();
    expect(sector.tag).toBe('数据不足');
  });
});

describe('trendAxisFromEntryScore', () => {
  it('按 60 / 45 阈值映射三态趋势轴', () => {
    expect(trendAxisFromEntryScore(100)).toBe('up');
    expect(trendAxisFromEntryScore(60)).toBe('up');
    expect(trendAxisFromEntryScore(59)).toBe('range');
    expect(trendAxisFromEntryScore(45)).toBe('range');
    expect(trendAxisFromEntryScore(44)).toBe('down');
    expect(trendAxisFromEntryScore(0)).toBe('down');
  });
});

describe('computeEntryMetrics', () => {
  /** 45 根温和上涨、振幅约 1% 的日线（覆盖「近两月」所需的 41 根）。 */
  function risingPoints(code = '881001'): BlockPricePoint[] {
    return Array.from({ length: 45 }, (_, index) => {
      const close = 10 + index * 0.1;
      const date = `2026-01-${String(index + 1).padStart(2, '0')}`;
      return point(code, date, Number(close.toFixed(2)), Number((close * 1.005).toFixed(3)), Number((close * 0.995).toFixed(3)));
    });
  }

  it('末根口径与 buildSectorRotation 的 entryScore 一致', () => {
    const points = risingPoints();
    const metrics = computeEntryMetrics(points, points.length - 1);
    expect(metrics).not.toBeNull();
    const [sector] = buildSectorRotation(points, 2026).sectors;
    expect(metrics!.entryScore).toBe(sector.entryScore);
    expect(metrics!.changePct).toBe(sector.changePct);
    expect(metrics!.tag).toBe(sector.tag);
    expect(metrics!.recentChangePct).toBe(sector.recentChangePct);
  });

  it('可截断到任意历史日复算；数据不足时返回 null', () => {
    const points = risingPoints();
    const mid = computeEntryMetrics(points, 30);
    expect(mid).not.toBeNull();
    // 截断到第 31 根：不足 41 根，近两月基准缺失 → tag 数据不足。
    expect(mid!.recentChangePct).toBeNull();
    expect(mid!.tag).toBe('数据不足');
    expect(computeEntryMetrics(points.slice(0, 1), 0)).toBeNull();
    expect(computeEntryMetrics(points, points.length)).toBeNull();
  });
});

describe('buildRotationScoreMap', () => {
  it('按目标日期所在年份过滤点位（YTD 基准 = 当年第一根）', () => {
    const prevYear: BlockPricePoint[] = [
      point('881001', '2025-12-29', 100),
      point('881001', '2025-12-30', 110),
    ];
    const currentYear: BlockPricePoint[] = [
      point('881001', '2026-01-05', 10),
      point('881001', '2026-01-06', 11),
      point('881001', '2026-01-07', 12),
    ];
    const map = buildRotationScoreMap([...prevYear, ...currentYear], ['2026-01-06']);
    const score = map.get('881001')?.get('20260106');
    expect(score).toBeTypeOf('number');
    // 与只用当年点位、截断到 1 月 6 日复算的结果一致（不含 2025 年高价基准）。
    expect(score).toBe(computeEntryMetrics(currentYear.slice(0, 2), 1)?.entryScore);
  });

  it('当年点位不足两根的日期不写入结果', () => {
    const rows = [
      point('881001', '2025-12-29', 100),
      point('881001', '2025-12-30', 110),
      point('881001', '2026-01-05', 10),
    ];
    const map = buildRotationScoreMap(rows, ['20260105', '20251230']);
    expect(map.get('881001')?.has('20260105')).toBe(false);
    expect(map.get('881001')?.has('20251230')).toBe(true);
  });
});
