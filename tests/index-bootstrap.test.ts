import { describe, expect, it, vi } from 'vitest';
import {
  ensureShanghaiIndexHistory,
  isShanghaiIndexHistorySufficient,
  latestTradingDayOnOrBefore,
  resolveLatestTradingDate,
  SHANGHAI_INDEX_MIN_TRADING_DAYS,
  shanghaiIndexHistoryStartThreshold,
} from '../server/index-bootstrap.js';

describe('shanghai index bootstrap', () => {
  it('picks the latest trading day on or before the ceiling date', () => {
    const calendar = ['20260720', '20260721', '20260722', '20260723', '20260724'];
    expect(latestTradingDayOnOrBefore(calendar, '20260725')).toBe('20260724');
    expect(latestTradingDayOnOrBefore(calendar, '20260724')).toBe('20260724');
    expect(latestTradingDayOnOrBefore(calendar, '20260719')).toBeNull();
  });

  it('keeps an explicit future trading date when local calendar has not caught up yet', async () => {
    const store = {
      getIndexTradingDays: vi.fn().mockResolvedValue(['20260720', '20260721', '20260722']),
      getHistoricalMarket: vi.fn(),
      getLatestAnalysisDate: vi.fn(),
    };
    await expect(resolveLatestTradingDate(store as never, '20260723')).resolves.toBe('20260723');
  });

  it('resolves weekend refresh to the latest trading day from the index calendar', async () => {
    const store = {
      getIndexTradingDays: vi.fn().mockResolvedValue(['20260722', '20260723', '20260724']),
      getHistoricalMarket: vi.fn(),
      getLatestAnalysisDate: vi.fn(),
    };
    await expect(resolveLatestTradingDate(store as never)).resolves.toBe('20260724');
  });

  it('falls back to historical snapshot calendar when index prices are empty', async () => {
    const store = {
      getIndexTradingDays: vi.fn().mockResolvedValue([]),
      getHistoricalMarket: vi.fn().mockResolvedValue({ calendar: ['20260721', '20260722'] }),
      getLatestAnalysisDate: vi.fn(),
    };
    await expect(resolveLatestTradingDate(store as never)).resolves.toBe('20260722');
  });

  it('requires both enough rows and a start date on or before the 3-year threshold', () => {
    const threshold = shanghaiIndexHistoryStartThreshold(new Date('2026-07-25T12:00:00+08:00'));
    expect(threshold).toBe('20230725');

    const enoughDays = Array.from({ length: SHANGHAI_INDEX_MIN_TRADING_DAYS }, (_, index) => {
      const day = 1 + (index % 28);
      const month = String(1 + Math.floor(index / 28)).padStart(2, '0');
      return `2023${month}${String(day).padStart(2, '0')}`;
    });
    expect(isShanghaiIndexHistorySufficient(['20230725', ...enoughDays.slice(1)], threshold)).toBe(true);
    expect(isShanghaiIndexHistorySufficient(['20230726', ...enoughDays.slice(1)], threshold)).toBe(false);
    expect(isShanghaiIndexHistorySufficient(['20230725'], threshold)).toBe(false);
  });

  it('backfills from Tencent when local sh000001 history is insufficient', async () => {
    const klines = Array.from({ length: 800 }, (_, index) => ({
      date: `2023-01-${String((index % 28) + 1).padStart(2, '0')}`,
      open: 3000 + index,
      close: 3001 + index,
      high: 3010 + index,
      low: 2990 + index,
      volume: 1_000_000,
      amount: 0,
    }));
    const store = {
      getIndexTradingDays: vi.fn().mockResolvedValueOnce(['20260721']).mockResolvedValueOnce(['20230701', '20260721']),
      upsertIndexPrices: vi.fn().mockResolvedValue(800),
    };
    const fetchSpy = vi.spyOn(await import('../server/historical-market.js'), 'fetchTencentKlines').mockResolvedValue(klines);

    const result = await ensureShanghaiIndexHistory(store as never);
    expect(result.backfilled).toBe(true);
    expect(result.inserted).toBe(800);
    expect(store.upsertIndexPrices).toHaveBeenCalledWith('sh000001', '上证指数', klines);
    fetchSpy.mockRestore();
  });

  it('skips network fetch when local history already covers 3 years', async () => {
    const tradingDays = Array.from({ length: SHANGHAI_INDEX_MIN_TRADING_DAYS }, (_, index) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      const month = String((index % 12) + 1).padStart(2, '0');
      return `2023${month}${day}`;
    });
    tradingDays[0] = '20230701';
    const store = {
      getIndexTradingDays: vi.fn().mockResolvedValue(tradingDays),
      upsertIndexPrices: vi.fn(),
    };
    const fetchSpy = vi.spyOn(await import('../server/historical-market.js'), 'fetchTencentKlines');

    const result = await ensureShanghaiIndexHistory(store as never);
    expect(result.backfilled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
