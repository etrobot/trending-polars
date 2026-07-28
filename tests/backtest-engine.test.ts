import { describe, expect, it } from 'vitest';
import {
  historicalCrossSectionRankings,
  historicalStrategyCandidates,
  runPolarsBacktest,
  sectorTrendLookupMap,
} from '../server/backtest-engine.js';
import { parseEastmoneyKlines } from '../server/historical-market.js';
import { historicalFixture } from './historical-fixture.js';

describe('historical scoring and backtest timing', () => {
  it('joins sector trend names from the lookup map when scoring the cross section', () => {
    const fixture = historicalFixture();
    const previousRows = fixture.stocks.map((stock, index) => ({
      rank: index + 1,
      stock_code: stock.stock_code,
      stock_name: stock.stock_name,
      total_score: 0,
      trend_score: 0,
      alignment: 'tangled',
      strategy_action: 'ignore' as const,
      strategy_label: '待计算',
      strategy_position: '—',
      sector_code: '881145',
      sector_name: '半导体',
    }));
    const sectorTrends = sectorTrendLookupMap([{
      sector_code: '881145',
      sector_name: '半导体',
      state_id: 1,
      state_name: '主线主升',
    }]);
    const date = fixture.calendar.at(-1)!;
    const rankings = historicalCrossSectionRankings(fixture, date, previousRows, sectorTrends);
    expect(rankings.length).toBeGreaterThan(0);
    expect(rankings.every((row) => row.sector_trend_name === '主线主升')).toBe(true);
    expect(rankings.every((row) => row.sector_trend_state_id === 1)).toBe(true);
  });

  it('keeps the 100-point score scale when every factor weight is boosted equally', () => {
    const fixture = historicalFixture();
    const date = fixture.calendar.at(-1)!;
    const baseline = historicalCrossSectionRankings(fixture, date);
    const boosted = historicalCrossSectionRankings(fixture, date, [], new Map(), {
      factorWeights: {
        trendWeightPct: 150,
        volumePriceWeightPct: 150,
        distanceFromLowWeightPct: 150,
        volatilityTrendWeightPct: 150,
        relativeStrengthWeightPct: 150,
      },
    });

    expect(boosted.map((row) => ({ code: row.stock_code, score: row.total_score })))
      .toEqual(baseline.map((row) => ({ code: row.stock_code, score: row.total_score })));
    expect(Math.max(...boosted.map((row) => row.total_score))).toBeLessThanOrEqual(100);
  });

  it('parses real daily bars without inventing fields', () => {
    const bars = parseEastmoneyKlines([
      '2026-07-22,10.81,10.98,10.98,10.77,1029484,1120150607.17,1.94,1.29,0.14,0.53',
    ]);
    expect(bars).toEqual([['20260722', 10.81, 10.98, 10.98, 10.77, 1029484, 1120150607.17, 1.29]]);
  });

  it('creates a signal at close and fills it only at the next trading-day open', () => {
    const fixture = historicalFixture();
    const result = runPolarsBacktest(fixture, { days: 10, maxHoldDays: 3 });
    const firstBuy = result.trades.find((trade) => trade.action === '买入');
    expect(firstBuy).toBeTruthy();
    const buyDateIndex = fixture.calendar.indexOf(firstBuy!.date);
    const signalDate = fixture.calendar[buyDateIndex - 1];
    expect(firstBuy!.reason).toContain(`信号日${signalDate}`);
    expect(historicalStrategyCandidates(fixture, signalDate).map((row) => row.stock_code)).toContain(firstBuy!.stock_code);
    const stock = fixture.stocks.find((item) => item.stock_code === firstBuy!.stock_code)!;
    const rawOpen = stock.bars.find((bar) => bar[0] === firstBuy!.date)![1];
    expect(firstBuy!.price).toBeCloseTo(rawOpen * 1.0005, 3);
    expect(result.methodology).toContain('下一交易日开盘成交');
  });

  it('does not let a later price change alter an earlier entry decision', () => {
    const baselineData = historicalFixture();
    const changedFuture = structuredClone(baselineData);
    const finalDate = changedFuture.calendar.at(-1)!;
    for (const stock of changedFuture.stocks) {
      const finalBar = stock.bars.find((bar) => bar[0] === finalDate);
      if (!finalBar) continue;
      finalBar[2] *= stock.stock_code === '600001' ? 4 : 0.25;
      finalBar[3] = Math.max(finalBar[1], finalBar[2]);
      finalBar[4] = Math.min(finalBar[1], finalBar[2]);
    }

    const baseline = runPolarsBacktest(baselineData, { days: 10, maxHoldDays: 3 });
    const changed = runPolarsBacktest(changedFuture, { days: 10, maxHoldDays: 3 });
    const earlierBuys = (result: typeof baseline) => result.trades
      .filter((trade) => trade.action === '买入' && trade.date < finalDate)
      .map((trade) => ({ date: trade.date, code: trade.stock_code, price: trade.price, reason: trade.reason }));
    expect(earlierBuys(changed)).toEqual(earlierBuys(baseline));
  });

  it('uses block_top records instead of a calculated price threshold for limit-up filtering', () => {
    const fixture = historicalFixture();
    const baseline = runPolarsBacktest(fixture, { days: 10, maxHoldDays: 3 });
    const firstBuy = baseline.trades.find((trade) => trade.action === '买入')!;
    const priceOnly = structuredClone(fixture);
    const stock = priceOnly.stocks.find((item) => item.stock_code === firstBuy.stock_code)!;
    const buyIndex = stock.bars.findIndex((bar) => bar[0] === firstBuy.date);
    const theoreticalLimitPrice = Number((stock.bars[buyIndex - 1][2] * 1.1).toFixed(3));
    stock.bars[buyIndex][1] = theoreticalLimitPrice;
    stock.bars[buyIndex][3] = Math.max(stock.bars[buyIndex][3], theoreticalLimitPrice);

    const priceOnlyResult = runPolarsBacktest(priceOnly, { days: 10, maxHoldDays: 3 });
    expect(priceOnlyResult.trades).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: '买入', stock_code: firstBuy.stock_code, date: firstBuy.date }),
    ]));

    const confirmed = structuredClone(priceOnly);
    confirmed.limit_up_records = [{ date: firstBuy.date, stock_code: firstBuy.stock_code, sector_code: '000000' }];
    const confirmedResult = runPolarsBacktest(confirmed, { days: 10, maxHoldDays: 3 });
    expect(confirmedResult.trades).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: '买入', stock_code: firstBuy.stock_code, date: firstBuy.date }),
    ]));
  });
});
