import { describe, expect, it } from 'vitest';
import { queryRankings } from '../server/polars-engine.js';
import type { RankingRow } from '../src/types.js';

function rankingRow(code: string, name: string, score: number): RankingRow {
  return {
    rank: 0,
    stock_code: code,
    stock_name: name,
    total_score: score,
    trend_score: score / 2,
    volume_price_score: 10,
    position_score: 8,
    volatility_trend_score: 5,
    alignment: 'bullish',
    sector_name: '半导体',
    strategy_action: 'accumulate',
    strategy_label: '趋势跟踪',
    strategy_position: '5-7成',
    latest_price: 10,
    latest_change_rate: 2,
  };
}

describe('queryRankings', () => {
  it('returns an empty response instead of throwing when the board is uncomputed', () => {
    // pl.DataFrame([]) is schema-less, so sort('total_score', …) would throw
    // `"total_score" not found`; the guard must short-circuit first.
    const response = queryRankings(
      { timestamp: '2026-07-23 15:00:00', date: '20260723', total_stocks: 0, rankings: [] },
      { sort: 'total_score', order: 'desc', page: 1, pageSize: 50 },
    );
    expect(response).toMatchObject({
      date: '20260723',
      total: 0,
      page: 1,
      page_size: 50,
      rankings: [],
      summary: { average_score: 0, median_score: 0, top_score: 0, actions: {} },
      sectors: [],
    });
  });

  it('sorts and summarizes a populated board through Polars', () => {
    const response = queryRankings(
      {
        timestamp: '2026-07-23 15:00:00',
        date: '20260723',
        total_stocks: 2,
        rankings: [rankingRow('000001', '平安银行', 40), rankingRow('600000', '浦发银行', 72)],
      },
      { sort: 'total_score', order: 'desc' },
    );
    expect(response.total).toBe(2);
    expect(response.rankings.map((row) => row.stock_code)).toEqual(['600000', '000001']);
    expect(response.summary.top_score).toBe(72);
    expect(response.sectors).toEqual(['半导体']);
  });
});
