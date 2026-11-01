import { describe, expect, it } from 'vitest';
import {
  buildSectorRotation,
  entryLevelOf,
  momentumTagOf,
  scoreSectorEntry,
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
