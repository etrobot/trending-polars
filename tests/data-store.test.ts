import { access, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore } from '../server/data-store.js';
import type { HistoricalMarketData } from '../server/historical-market.js';
import type { AnalysisData, RankingRow } from '../src/types.js';

let root = '';
let store: DataStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'trending-sqlite-test-'));
  store = new DataStore(root);
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

function rankingRow(code: string, name: string, score: number): RankingRow {
  return {
    rank: 99,
    stock_code: code,
    stock_name: name,
    total_score: score,
    trend_score: score / 2,
    volume_price_score: 10,
    position_score: 8,
    volatility_trend_score: 5,
    alignment: 'bullish',
    trend_strength: 0.01,
    volume_price_label: '稳健放量',
    volatility_class: 'medium',
    sector_code: '881145',
    sector_name: '半导体',
    sector_trend_name: '主线主升',
    strategy_action: 'accumulate',
    strategy_label: '趋势跟踪',
    strategy_position: '5-7成',
    latest_price: 10,
    latest_change_rate: 2,
  };
}

function blockTopAnalysis(stockCode = '600000', stockName = '浦发银行'): AnalysisData {
  return {
    timestamp: '2026-07-23 15:10:00',
    indices: [],
    sentiment: { total_blocks: 1, total_limit_up: 1, sentiment: 'normal' },
    blocks: [{
      code: '881145',
      name: '半导体',
      block_info: { limit_up_num: 1, change: 2.5, max_continue: 1 },
      trend: {
        state_id: 1,
        state_name: '主线主升',
        trend: '上升趋势',
        latest: 120,
        ma5: 118,
        ma20: 110,
        near_high: '-1.00%',
        volume_trend: '放量',
      },
      strategy: { action: 'accumulate', label: '主线主升', position: '7-9成' },
      stock_list: [{ code: stockCode, name: stockName, continue_num: 0, reason_type: '测试' }],
    }],
  };
}

function historicalMarketFixture(): HistoricalMarketData {
  return {
    schema_version: 1,
    source: 'multi-source-qfq',
    generated_at: '2026-07-23 15:20:00',
    as_of_date: '20260723',
    universe_as_of_date: '20260723',
    requested_days: 5,
    warmup_days: 2,
    calendar: ['20260721', '20260722', '20260723'],
    stocks: [{
      stock_code: '600000',
      stock_name: '浦发银行',
      bars: [
        ['20260721', 10, 10.1, 10.2, 9.9, 1000, 10_000, 1],
        ['20260722', 10.1, 10.2, 10.3, 10, 1100, 11_000, 0.99],
        ['20260723', 10.2, 10.4, 10.5, 10.1, 1200, 12_000, 1.96],
      ],
    }],
    indices: [{
      symbol: 'sh000001',
      index_name: '上证指数',
      bars: [
        ['20260721', 3000, 3010, 3020, 2990, 100, 1000, 0.3],
        ['20260722', 3010, 3020, 3030, 3000, 110, 1100, 0.33],
        ['20260723', 3020, 3030, 3040, 3010, 120, 1200, 0.33],
      ],
    }],
    failed_stocks: 0,
  };
}

describe('node:sqlite data store', () => {
  it('boots with empty snapshots when the ignored data directory has no seed files', async () => {
    await expect(store.getAnalysis()).resolves.toMatchObject({ blocks: [], indices: [] });
    await expect(store.getRanking()).resolves.toMatchObject({ total_stocks: 0, rankings: [] });
  });

  it('derives the ranking universe from the latest limit-up cohort when no ranking is computed', async () => {
    // No analysis at all: universe is empty, mirroring getRanking().
    await expect(store.getRankingUniverse()).resolves.toMatchObject({ total_stocks: 0, rankings: [] });

    // Analysis-only database (limit-up facts, no computed ranking): getRanking()
    // stays empty, but the universe bootstraps from the limit-up cohort so
    // ranking/backtest/paper-trading can run.
    await store.saveAnalysis(blockTopAnalysis(), '20260723');
    await expect(store.getRanking()).resolves.toMatchObject({ total_stocks: 0, rankings: [] });
    const universe = await store.getRankingUniverse();
    expect(universe.date).toBe('20260723');
    expect(universe.total_stocks).toBe(1);
    expect(universe.rankings).toEqual([
      expect.objectContaining({ stock_code: '600000', stock_name: '浦发银行', sector_code: '881145', total_score: 0 }),
    ]);

    // Once a real ranking exists it takes precedence over the derived universe.
    await store.saveRanking({
      timestamp: '2026-07-23 15:05:00',
      date: '20260723',
      total_stocks: 1,
      rankings: [rankingRow('600000', '浦发银行', 72)],
    });
    const scored = await store.getRankingUniverse();
    expect(scored.rankings).toHaveLength(1);
    expect(scored.rankings[0].stock_code).toBe('600000');
    expect(scored.rankings[0].total_score).toBeGreaterThan(0);
    expect(scored.rankings[0].strategy_label).not.toBe('待计算');
  });

  it('initializes the documented schema with WAL and foreign keys', () => {
    const status = store.getStorageStatus();
    expect(status.database_path).toBe(path.join(root, 'trending.db'));
    expect(status.journal_mode).toBe('wal');
    expect(status.foreign_keys).toBe(true);
    expect(status.busy_timeout_ms).toBe(5000);
    expect(status.synchronous).toBe('normal');
    expect(status.schema_version).toBe(17);
    expect(status.tables).toEqual(expect.arrayContaining([
      'stock_info',
      'sector_info',
      'limit_up_record',
      'stock_daily_price',
      'index_daily_price',
      'sector_trend_daily',
      'ranking_factor',
      'stock_ranking',
    ]));
  });

  it('uses ranking_factor as the canonical ranking source and keeps a JSON cache', async () => {
    await store.saveAnalysis(blockTopAnalysis(), '20260723');
    await store.saveRanking({
      timestamp: '2026-07-23 15:05:00',
      date: '20260723',
      total_stocks: 2,
      rankings: [
        rankingRow('000001', '平安银行', 55),
        rankingRow('600000', '浦发银行', 72),
      ],
    });

    const loaded = await store.getRanking();
    expect(loaded.rankings.map((row) => row.stock_code)).toEqual(['600000', '000001']);
    expect(loaded.rankings.map((row) => row.rank)).toEqual([1, 2]);
    const factors = await store.getRankingFactorsForDate('20260723');
    expect(factors).toEqual(expect.arrayContaining([
      expect.objectContaining({ stock_code: '600000', factor_name: 'limit_up_count_20d', val_numeric: 1 }),
      expect.objectContaining({ stock_code: '000001', factor_name: 'limit_up_count_20d', val_numeric: 0 }),
      expect.objectContaining({ stock_code: '000001', factor_name: 'volume_price_label', val_text: '稳健放量' }),
    ]));
    await expect(access(path.join(root, 'runtime', 'ranking.json'))).resolves.toBeUndefined();

    await store.clearRankingData();
    await expect(store.getRanking()).resolves.toMatchObject({ total_stocks: 0, rankings: [] });
    await expect(access(path.join(root, 'runtime', 'ranking.json'))).rejects.toThrow();
  });

  it('rolls back the whole ranking batch when a row cannot be serialized', async () => {
    const invalid = {
      ...rankingRow('600099', '事务测试', 70),
      unsupported_bigint: 1n,
    };

    await expect(store.saveRanking({
      timestamp: '2026-07-23 15:05:00',
      date: '20260723',
      total_stocks: 1,
      rankings: [invalid],
    })).rejects.toThrow();

    await expect(store.getStockName('600099')).resolves.toBeNull();
    await expect(store.getRankingFactorsForDate('20260723')).resolves.toEqual([]);
  });

  it('persists limit-up records and sector trends transactionally', async () => {
    await store.saveAnalysis(blockTopAnalysis(), '20260723');
    const records = await store.getLimitUpByDate('2026-07-23');
    expect(records).toEqual([
      expect.objectContaining({ stock_code: '600000', continue_num: 1, sector_code: '881145' }),
    ]);
    const trends = await store.getSectorTrendsForDate('20260723');
    expect(trends).toEqual([
      expect.objectContaining({ sector_code: '881145', state_id: 1, strategy_action: 'accumulate' }),
    ]);
    await expect(store.getSectorStats('20260723')).resolves.toEqual([
      expect.objectContaining({ sector_code: '881145', limit_up_count: 1, max_continue: 1 }),
    ]);
    await expect(store.getLatestAnalysisDate()).resolves.toBe('20260723');
    await unlink(path.join(root, 'runtime', 'analysis.json'));
    store.close();
    store = new DataStore(root);
    await expect(store.getAnalysis()).resolves.toMatchObject({
      blocks: [expect.objectContaining({ code: '881145', stock_list: [expect.objectContaining({ code: '600000' })] })],
    });
  });

  it('keeps SQLite structured analysis canonical when the JSON cache is stale', async () => {
    await store.saveAnalysis(blockTopAnalysis('600000', '浦发银行'), '20260723');
    const stale = blockTopAnalysis('000001', '平安银行');
    stale.timestamp = '2026-07-22 15:10:00';
    await writeFile(path.join(root, 'runtime', 'analysis.json'), JSON.stringify(stale), 'utf8');

    store.close();
    store = new DataStore(root);
    const loaded = await store.getAnalysis();

    expect(loaded.blocks[0].stock_list[0].code).toBe('600000');
    expect(await store.getLimitUpByDate('20260722')).toEqual([]);
    expect(await store.getLimitUpByDate('20260723')).toEqual([
      expect.objectContaining({ stock_code: '600000' }),
    ]);
  });

  it('serves canonical SQLite analysis when the JSON cache is corrupt', async () => {
    await store.saveAnalysis(blockTopAnalysis(), '20260723');
    await writeFile(path.join(root, 'runtime', 'analysis.json'), '{not-json', 'utf8');

    store.close();
    store = new DataStore(root);

    await expect(store.getAnalysis()).resolves.toMatchObject({
      blocks: [expect.objectContaining({ stock_list: [expect.objectContaining({ code: '600000' })] })],
    });
  });

  it('can refresh the JSON analysis cache without minting limit-up records', async () => {
    await store.saveAnalysis(blockTopAnalysis(), '20260723');
    const refreshed = blockTopAnalysis();
    refreshed.timestamp = '2026-07-24 09:30:00';

    await store.saveAnalysisCache(refreshed);

    expect(await store.getLimitUpByDate('20260724')).toEqual([]);
    expect(await store.getLimitUpByDate('20260723')).toEqual([
      expect.objectContaining({ stock_code: '600000' }),
    ]);

    store.close();
    await Promise.all([
      rm(path.join(root, 'trending.db'), { force: true }),
      rm(path.join(root, 'trending.db-wal'), { force: true }),
      rm(path.join(root, 'trending.db-shm'), { force: true }),
    ]);
    store = new DataStore(root);
    await store.getAnalysis();

    expect(await store.getLimitUpByDate('20260724')).toEqual([]);
    expect(await store.getLimitUpByDate('20260723')).toEqual([
      expect.objectContaining({ stock_code: '600000' }),
    ]);
  });

  it('imports legacy JSON seeds and remains usable after the seed files are removed', async () => {
    await writeFile(path.join(root, 'analysis.json'), JSON.stringify(blockTopAnalysis()), 'utf8');
    await writeFile(path.join(root, 'ranking.json'), JSON.stringify({
      timestamp: '2026-07-23 15:05:00',
      date: '20260723',
      total_stocks: 1,
      rankings: [rankingRow('600000', '浦发银行', 72)],
    }), 'utf8');
    await writeFile(path.join(root, 'historical-market.json'), JSON.stringify(historicalMarketFixture()), 'utf8');

    await expect(store.getAnalysis()).resolves.toMatchObject({ blocks: [expect.any(Object)] });
    await expect(store.getRanking()).resolves.toMatchObject({ rankings: [expect.objectContaining({ stock_code: '600000' })] });
    await expect(store.getHistoricalMarket()).resolves.toMatchObject({ as_of_date: '20260723' });

    await unlink(path.join(root, 'analysis.json'));
    await unlink(path.join(root, 'ranking.json'));
    await unlink(path.join(root, 'historical-market.json'));
    await unlink(path.join(root, 'runtime', 'ranking.json'));
    store.close();
    store = new DataStore(root);

    await expect(store.getAnalysis()).resolves.toMatchObject({ blocks: [expect.any(Object)] });
    await expect(store.getRanking()).resolves.toMatchObject({ rankings: [expect.objectContaining({ stock_code: '600000' })] });
    await expect(store.getHistoricalMarket()).resolves.toMatchObject({ as_of_date: '20260723' });
  });

  it('stores historical stock and index bars in SQLite instead of historical-market.json', async () => {
    await store.saveAnalysis(blockTopAnalysis(), '20260723');
    const history = historicalMarketFixture();

    await store.saveHistoricalMarket(history);
    const loaded = await store.getHistoricalMarket();
    expect(loaded).toMatchObject({ as_of_date: '20260723', requested_days: 5, failed_stocks: 0 });
    expect(loaded?.stocks[0].bars).toHaveLength(3);
    expect(loaded?.limit_up_records).toEqual([{ date: '20260723', stock_code: '600000', sector_code: '881145' }]);
    expect(await store.getIndexTradingDays('sh000001')).toEqual(['20260721', '20260722', '20260723']);
    expect(await store.loadAllDailyPrices()).toHaveLength(3);
    expect(await store.getAllStockPriceCoverage('20260721', '20260723')).toEqual([
      expect.objectContaining({ stock_code: '600000', first_date: '2026-07-21', last_date: '2026-07-23', row_count: 3 }),
    ]);
    await expect(access(path.join(root, 'runtime', 'historical-market.json'))).rejects.toThrow();
  });
});
