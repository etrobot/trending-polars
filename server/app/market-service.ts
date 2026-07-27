import { randomUUID } from 'node:crypto';
import type { AnalysisData, BlockAnalysis, IndexAnalysis, LimitUpStock, RankingRow } from '../../src/types.js';
import type { AuditLoggerLike } from '../audit-log.js';
import { historicalCrossSectionRankings, sectorTrendLookupMap, type SectorTrendLookup } from '../backtest-engine.js';
import { compactDate, formatDateTime, round } from '../format.js';
import {
  assessHistoricalMarketCoverage,
  collectHistoricalMarketData,
  fetchAdjustedKlines,
  fetchBlockKlines,
  fetchBlockTop,
  MAX_BACKTEST_DAYS,
  MIN_BACKTEST_DAYS,
  normalizeBacktestDays,
  type BlockKlinePeriod,
  type BlockTopData,
  type HistoricalMarketData,
  type KLineData,
} from '../historical-market.js';
import { resolveLatestTradingDate } from '../index-bootstrap.js';
import { queryRankings, refreshAnalysis } from '../polars-engine.js';
import { analyzeBlockTrend, blockStrategy, classifyMarketState, klinesToBars, DEFAULT_SCORE_STOCK_CONFIG, type MarketStateThresholds } from '../scoring-engine.js';
import type { DataStore } from '../data-store.js';
import {
  BLOCK_PERIOD_DAILY,
  BLOCK_PERIOD_WEEKLY,
  BLOCK_PERIOD_MONTHLY,
} from '../sqlite/helpers.js';
import { defaultRankingRuntimeConfig, type RankingRuntimeConfig } from '../ranking-config.js';

// ---------------------------------------------------------------------------
// Reusable helpers
// ---------------------------------------------------------------------------

function numberParam(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function marketDateParam(value: unknown, fallback = compactDate().slice(0, 8)): string {
  const normalized = String(value ?? '').replace(/\D/g, '').slice(0, 8);
  return /^\d{8}$/.test(normalized) ? normalized : fallback;
}

function stockSymbol(code: string): string {
  return `${/^(6|68|5|9)/.test(code) ? 'sh' : 'sz'}${code}`;
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const run = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, () => run()));
}

const INDEX_NAMES: Record<string, string> = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
  sh000688: '科创50',
  sh000300: '沪深300',
  sh000905: '中证500',
  sz399997: '中证白酒',
  sh000933: '中证医药',
  sz399975: '证券公司',
  sz980017: '国证芯片',
  sz399967: '中证军工',
};

function indexName(symbol: string): string {
  return INDEX_NAMES[symbol] ?? symbol;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function analysisWithStats(data: AnalysisData): AnalysisData {
  const enriched = refreshAnalysis(data);
  return { ...enriched, timestamp: data.timestamp };
}

export function buildBlockAnalysis(
  block: BlockTopData,
  daily: KLineData[],
  weekly: KLineData[],
  monthly: KLineData[],
  marketLimitUpTotal?: number,
  thresholds: MarketStateThresholds = DEFAULT_SCORE_STOCK_CONFIG.marketState,
): BlockAnalysis {
  const trend = analyzeBlockTrend(klinesToBars(daily), klinesToBars(weekly), klinesToBars(monthly), thresholds);
  const strategy = blockStrategy(trend.state_id, block.limit_up_num, block.continuous_plate_num, {
    marketLimitUpTotal,
    higherTimeframe: trend.higher_timeframe,
  });
  const stockList: LimitUpStock[] = block.stock_list.map((stock) => ({
    code: stock.code,
    name: stock.name,
    continue_num: stock.continue_num,
    reason_type: stock.reason_type || null,
    change_rate: stock.change_rate ?? undefined,
    latest: stock.latest ?? undefined,
  }));
  return {
    name: block.name,
    code: block.code,
    block_info: {
      limit_up_num: block.limit_up_num,
      change: block.change,
      max_continue: block.continuous_plate_num,
      stock_list: stockList,
    },
    trend: {
      state_id: trend.state_id,
      state_name: trend.state_name,
      trend: trend.trend,
      position: trend.position,
      near_high: trend.near_high,
      volume_trend: trend.volume_trend,
      latest: trend.latest ?? undefined,
      ma5: trend.ma5,
      ma20: trend.ma20,
      // 审计字段：过去在这里被丢弃，导致 sector_trend_daily 的 adx/downgraded 恒为默认值。
      adx: trend.adx,
      plus_di: trend.plus_di,
      minus_di: trend.minus_di,
      downgraded: trend.downgraded,
      adjusted: trend.adjusted,
      adjust_direction: trend.adjust_direction,
      original_state_id: trend.original_state_id,
      original_state_name: trend.original_state_name,
      confirmations: trend.confirmations,
    },
    strategy: { action: strategy.action, label: strategy.label, position: strategy.position },
    stock_list: stockList,
  };
}

export function priceRows(klines: KLineData[]) {
  const closes = klines.map((kline) => kline.close);
  const movingAverage = (index: number, window: number) => {
    const values = closes.slice(Math.max(0, index - window + 1), index + 1);
    return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
  };
  return klines.map((kline, index) => ({
    date: kline.date,
    open: round(kline.open, 3),
    high: round(kline.high, 3),
    low: round(kline.low, 3),
    close: round(kline.close, 3),
    volume: kline.volume,
    amount: round(kline.amount, 2),
    change_pct: round(kline.changeRate ?? 0, 2),
    ma5: movingAverage(index, 5),
    ma10: movingAverage(index, 10),
    ma20: movingAverage(index, 20),
  }));
}

export function averageRankingChange(rankings: Array<{ latest_change_rate?: number | null }>): number | undefined {
  const values = rankings.flatMap((row) => {
    if (row.latest_change_rate == null) return [];
    const value = Number(row.latest_change_rate);
    return Number.isFinite(value) ? [value] : [];
  });
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

export function averageHistoricalChange(history: HistoricalMarketData, date: string): number | undefined {
  const target = date.replaceAll('-', '').slice(0, 8);
  const values = history.stocks.flatMap((stock) => {
    const bar = [...stock.bars].reverse().find((item) => item[0] <= target);
    return bar && Number.isFinite(Number(bar[7])) ? [Number(bar[7])] : [];
  });
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

// ---------------------------------------------------------------------------
// MarketService class
// ---------------------------------------------------------------------------

export class MarketService {
  private historicalPreparationInFlight: Promise<HistoricalMarketData> | null = null;

  constructor(
    private readonly store: DataStore,
    private readonly audit: AuditLoggerLike,
  ) {}

  /**
   * 涨停采集 → 板块 K 线 → 趋势分类 → 情绪重算的完整流水线（ref-doc §1/§3）。
   * 保留现有 indices，仅重建 blocks 与 sentiment；同花顺不可用时返回空块并保留原分析。
   *
   * 增量采集策略（避免重复请求）：
   * - 日线：若 SQLite 已存最新交易日 = date，直接复用，不再请求网络。
   * - 周/月线：若 SQLite 已存最新周期 K 线覆盖 date，直接复用。
   * - 未命中时才发起网络请求，并将结果落库供回测/模拟交易兜底复用。
   */
  async collectLimitUpAnalysis(
    base: AnalysisData,
    date: string,
    options: { progress?: (pct: number, message: string) => void; cancelled?: () => boolean; concurrency?: number } = {},
  ): Promise<{ analysis: AnalysisData; blocks: number; blocks_with_klines: number; source: 'ths-limit-up' | 'none' }> {
    const { blocks: tops, source } = await fetchBlockTop(date);
    if (!tops.length) return { analysis: base, blocks: 0, blocks_with_klines: 0, source };
    // 全市场涨停总数：blockStrategy 用它把板块热度相对化（冷市场 5 家已是主线，
    // 热市场 5 家很普通），而不是拿固定阈值 5 一刀切。
    const marketLimitUpTotal = tops.reduce((sum, item) => sum + Number(item.limit_up_num ?? 0), 0);
    const results: BlockAnalysis[] = [];
    let cursor = 0;
    let done = 0;
    let blocksWithKlines = 0;
    let cachedBlocks = 0;
    let fetchedBlocks = 0;
    const concurrency = Math.min(6, Math.max(1, options.concurrency ?? 4));
    const worker = async () => {
      while (true) {
        if (options.cancelled?.()) return;
        const index = cursor;
        cursor += 1;
        if (index >= tops.length) return;
        const block = tops[index];
        const [dailyStored, weeklyStored, monthlyStored] = await Promise.all([
          this.store.getBlockLatestKlineDate(block.code, BLOCK_PERIOD_DAILY),
          this.store.getBlockLatestKlineDate(block.code, BLOCK_PERIOD_WEEKLY),
          this.store.getBlockLatestKlineDate(block.code, BLOCK_PERIOD_MONTHLY),
        ]);
        const dailyCacheHit = dailyStored && dailyStored >= date;
        const weeklyCacheHit = weeklyStored && weeklyStored >= date;
        const monthlyCacheHit = monthlyStored && monthlyStored >= date;
        let dailyKlines: KLineData[];
        let weeklyKlines: KLineData[];
        let monthlyKlines: KLineData[];
        if (dailyCacheHit && weeklyCacheHit && monthlyCacheHit) {
          // 三周期全部命中缓存，直接从 SQLite 读，避免任何网络请求。
          cachedBlocks += 1;
          const [dailyCached, weeklyCached, monthlyCached] = await Promise.all([
            this.store.getBlockPrices(block.code, 250, BLOCK_PERIOD_DAILY),
            this.store.getBlockPrices(block.code, 30, BLOCK_PERIOD_WEEKLY),
            this.store.getBlockPrices(block.code, 30, BLOCK_PERIOD_MONTHLY),
          ]);
          dailyKlines = dailyCached.filter((kline) => marketDateParam(kline.date, '') <= date);
          weeklyKlines = weeklyCached.filter((kline) => marketDateParam(kline.date, '') <= date);
          monthlyKlines = monthlyCached.filter((kline) => marketDateParam(kline.date, '') <= date);
        } else {
          // 至少一个周期未命中，发起网络请求并落库。
          fetchedBlocks += 1;
          const [daily, weekly, monthly] = await Promise.all([
            fetchBlockKlines(block.code, '01', 250),
            fetchBlockKlines(block.code, '11', 30),
            fetchBlockKlines(block.code, '21', 30),
          ]);
          const throughDate = (kline: KLineData) => marketDateParam(kline.date, '') <= date;
          dailyKlines = daily.klines.filter(throughDate);
          weeklyKlines = weekly.klines.filter(throughDate);
          monthlyKlines = monthly.klines.filter(throughDate);
          // 落库供下次复用：日线全量、周月线全量（数据量小）。
          if (dailyKlines.length) {
            await this.store.upsertBlockPrices(block.code, block.name, daily.klines, BLOCK_PERIOD_DAILY);
          }
          if (weeklyKlines.length) {
            await this.store.upsertBlockPrices(block.code, block.name, weekly.klines, BLOCK_PERIOD_WEEKLY);
          }
          if (monthlyKlines.length) {
            await this.store.upsertBlockPrices(block.code, block.name, monthly.klines, BLOCK_PERIOD_MONTHLY);
          }
        }
        if (dailyKlines.length >= 20) blocksWithKlines += 1;
        results.push(buildBlockAnalysis(block, dailyKlines, weeklyKlines, monthlyKlines, marketLimitUpTotal));
        done += 1;
        options.progress?.(done / tops.length * 100, `板块趋势分类 ${done}/${tops.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tops.length) }, () => worker()));
    results.sort((left, right) => right.block_info.limit_up_num - left.block_info.limit_up_num);
    if (cachedBlocks > 0) {
      await this.audit.info('market_data', 'block_kline_cache_hit', {
        data: { cached: cachedBlocks, fetched: fetchedBlocks, total: tops.length },
      });
    }
    const analysis: AnalysisData = { ...base, timestamp: formatDateTime(), blocks: results };
    return { analysis: refreshAnalysis(analysis), blocks: results.length, blocks_with_klines: blocksWithKlines, source };
  }

  async refreshBlockStockQuotes(
    analysis: AnalysisData,
    date: string,
    options: { progress?: (completed: number, total: number, message: string) => void; cancelled?: () => boolean } = {},
  ): Promise<{ analysis: AnalysisData; requested: number; loaded: number; rows: number }> {
    const stocks = [...new Map(
      analysis.blocks.flatMap((block) => block.stock_list ?? [])
        .filter((stock) => /^\d{6}$/.test(stock.code))
        .map((stock) => [stock.code, { code: stock.code, name: stock.name || stock.code }]),
    ).values()];
    const quotes = new Map<string, { latest: number; change_rate: number }>();
    let loaded = 0;
    let rows = 0;
    let completed = 0;
    await runConcurrent(stocks, 12, async (stock) => {
      if (options.cancelled?.()) return;
      const marketData = await fetchAdjustedKlines(stockSymbol(stock.code), 120);
      const eligible = marketData.klines.filter((kline) => marketDateParam(kline.date, '') <= date);
      const latest = eligible.at(-1);
      if (latest) {
        rows += await this.store.upsertStockPrices(stock.code, stock.name, marketData.klines);
        quotes.set(stock.code, { latest: latest.close, change_rate: latest.changeRate ?? 0 });
        loaded += 1;
      }
      completed += 1;
      options.progress?.(completed, stocks.length, `采集涨停个股行情 ${completed}/${stocks.length}`);
    });
    const enrich = (stock: LimitUpStock): LimitUpStock => {
      const quote = quotes.get(stock.code);
      return quote ? { ...stock, latest: quote.latest, change_rate: quote.change_rate } : stock;
    };
    return {
      analysis: {
        ...analysis,
        blocks: analysis.blocks.map((block) => {
          const stockList = block.stock_list.map(enrich);
          return { ...block, stock_list: stockList, block_info: { ...block.block_info, stock_list: stockList } };
        }),
      },
      requested: stocks.length,
      loaded,
      rows,
    };
  }

  /**
   * 异步刷新某板块关联全部个股的 K 线：个股清单取自 store.getSectorStocks
   * （limit_up_record 累积去重），逐一并发抓取并落库 stock_daily_price。
   */
  async refreshSectorStockKlines(
    sectorCode: string,
    options: { progress?: (completed: number, total: number, message: string) => void; cancelled?: () => boolean } = {},
  ): Promise<{ requested: number; loaded: number; rows: number }> {
    const records = await this.store.getSectorStocks(sectorCode);
    const stocks = records.map((record) => ({ code: record.stock_code, name: record.stock_name }));
    let loaded = 0;
    let rows = 0;
    let completed = 0;
    await runConcurrent(stocks, 12, async (stock) => {
      if (options.cancelled?.()) return;
      const marketData = await fetchAdjustedKlines(stockSymbol(stock.code), 120);
      if (marketData.klines.length) {
        rows += await this.store.upsertStockPrices(stock.code, stock.name, marketData.klines);
        loaded += 1;
      }
      completed += 1;
      options.progress?.(completed, stocks.length, `采集板块个股行情 ${completed}/${stocks.length}`);
    });
    return { requested: stocks.length, loaded, rows };
  }

  async refreshIndexAnalysis(
    date: string,
    options: { progress?: (completed: number, total: number, message: string) => void; cancelled?: () => boolean } = {},
  ): Promise<{ indices: IndexAnalysis[]; requested: number; rows: number }> {
    const symbols = Object.keys(INDEX_NAMES);
    const indices: IndexAnalysis[] = [];
    let completed = 0;
    let rows = 0;
    await runConcurrent(symbols, 6, async (symbol) => {
      if (options.cancelled?.()) return;
      const marketData = await fetchAdjustedKlines(symbol, 250);
      const eligible = marketData.klines.filter((kline) => marketDateParam(kline.date, '') <= date);
      const latest = eligible.at(-1);
      if (latest) {
        rows += await this.store.upsertIndexPrices(symbol, indexName(symbol), marketData.klines);
        const state = classifyMarketState(klinesToBars(eligible));
        indices.push({
          name: indexName(symbol),
          code: symbol,
          state,
          price: latest.close,
          date: latest.date,
          indicators: {
            source: marketData.source,
            ma5: state.ma5,
            ma20: state.ma20,
            near_high: state.near_high,
            volume_trend: state.volume_trend,
          },
          signal: state.signal,
        });
      }
      completed += 1;
      options.progress?.(completed, symbols.length, `采集指数行情 ${completed}/${symbols.length}`);
    });
    indices.sort((left, right) => symbols.indexOf(left.code) - symbols.indexOf(right.code));
    return { indices, requested: symbols.length, rows };
  }

  async ensureHistoricalCoverage(options: {
    rankings: RankingRow[];
    days: number;
    asOfDate: string;
    traceId: string;
    force?: boolean;
    cancelled?: () => boolean;
    progress?: (value: number, message: string) => void;
  }): Promise<{ history: HistoricalMarketData; collected: boolean }> {
    const requestedDate = marketDateParam(options.asOfDate);
    let history = await this.store.getHistoricalMarket();
    let coverage = assessHistoricalMarketCoverage(history, options.rankings, { days: options.days, asOfDate: requestedDate });
    await this.audit.info('market_data', 'coverage_checked', {
      traceId: options.traceId,
      data: coverage,
    });
    if (!options.force && coverage.usable && history) {
      options.progress?.(20, `行情覆盖已满足：${coverage.covered_stocks}/${coverage.universe_size} 只`);
      await this.audit.info('market_data', 'snapshot_cache_hit', {
        traceId: options.traceId,
        data: { ...coverage, generated_at: history.generated_at },
      });
      return { history, collected: false };
    }

    if (this.historicalPreparationInFlight) {
      options.progress?.(8, '等待正在进行的个股行情采集');
      await this.historicalPreparationInFlight;
      history = await this.store.getHistoricalMarket();
      coverage = assessHistoricalMarketCoverage(history, options.rankings, { days: options.days, asOfDate: requestedDate });
      if (!options.force && coverage.usable && history) return { history, collected: false };
    }

    options.progress?.(3, `覆盖不足，开始获取 ${requestedDate} 前 ${options.days} 日个股行情`);
    const requestedDays = normalizeBacktestDays(options.days);
    const tradingDays = history?.calendar?.slice(-requestedDays) ?? [];
    const existingLimitUpRecords = tradingDays.length > 0
      ? await this.store.loadLimitUpRecordsForDateRange(tradingDays[0], tradingDays.at(-1) ?? requestedDate)
      : [];
    const existingBlockSeries = history?.blocks?.length ? history.blocks : undefined;
    const collection = (async () => {
      const result = await collectHistoricalMarketData(options.rankings, {
        days: options.days,
        asOfDate: requestedDate,
        existingLimitUpRecords,
        existingBlockSeries,
        cancelled: options.cancelled,
        audit: this.audit,
        traceId: options.traceId,
        progress: (completed, total, message) => options.progress?.(8 + completed / total * 82, message),
      });
      if (!result) throw new Error('个股行情采集未完成');
      await this.store.saveHistoricalMarket(result);
      const persisted = await this.store.getHistoricalMarket() ?? result;
      await this.audit.info('market_data', 'snapshot_saved', {
        traceId: options.traceId,
        data: {
          database: this.store.databasePath,
          tables: ['stock_daily_price', 'index_daily_price', 'historical_snapshot'],
          as_of_date: persisted.as_of_date,
          stocks: persisted.stocks.length,
          failed_stocks: persisted.failed_stocks,
        },
      });
      return persisted;
    })();
    this.historicalPreparationInFlight = collection;
    try {
      history = await collection;
    } finally {
      if (this.historicalPreparationInFlight === collection) this.historicalPreparationInFlight = null;
    }

    coverage = assessHistoricalMarketCoverage(history, options.rankings, { days: options.days, asOfDate: requestedDate });
    await this.audit.info('market_data', 'coverage_verified', {
      traceId: options.traceId,
      data: coverage,
    });
    if (!coverage.usable) throw new Error(`个股行情仍不能覆盖需求日期段：${coverage.reasons.join('；')}`);
    options.progress?.(94, `行情覆盖校验通过：${coverage.covered_stocks}/${coverage.universe_size} 只`);
    return { history, collected: true };
  }

  async refreshMarketAnalysis(options: {
    date?: string;
    traceId: string;
    cancelled?: () => boolean;
    progress?: (value: number, message: string) => void;
  }) {
    const date = await resolveLatestTradingDate(this.store, options.date);
    const base = await this.store.getAnalysis();
    options.progress?.(4, `获取 ${date} 同花顺 blocktop`);
    const collected = await this.collectLimitUpAnalysis(base, date, {
      cancelled: options.cancelled,
      progress: (pct, message) => options.progress?.(8 + pct * 0.38, message),
    });
    if (!collected.blocks) {
      await this.audit.warn('market_analysis', 'limit_up_collection_empty', {
        traceId: options.traceId,
        data: { date, source: collected.source },
      });
      options.progress?.(100, '同花顺 blocktop 数据不可用，已保留现有分析快照');
      return {
        analysis: base,
        date,
        blocks: 0,
        blocktop_source: 'none',
        stock_quotes: 0,
        indices: 0,
        message: '同花顺 blocktop 数据不可用，已保留现有分析快照',
      };
    }
    const minimumBlockCoverage = Math.min(collected.blocks, Math.max(1, Math.floor(collected.blocks * 0.2)));
    if (collected.blocks_with_klines < minimumBlockCoverage) {
      throw new Error(`板块 K 线覆盖不足：${collected.blocks_with_klines}/${collected.blocks}`);
    }
    if (options.cancelled?.()) throw new Error('分析刷新已停止');

    const quoted = await this.refreshBlockStockQuotes(collected.analysis, date, {
      cancelled: options.cancelled,
      progress: (completed, total, message) => options.progress?.(48 + completed / Math.max(1, total) * 24, message),
    });
    const minimumStockCoverage = quoted.requested
      ? Math.min(quoted.requested, Math.max(1, Math.floor(quoted.requested * 0.2)))
      : 0;
    if (!quoted.requested || quoted.loaded < minimumStockCoverage) {
      throw new Error(`涨停个股行情覆盖不足：${quoted.loaded}/${quoted.requested}`);
    }
    if (options.cancelled?.()) throw new Error('分析刷新已停止');

    const indexResult = await this.refreshIndexAnalysis(date, {
      cancelled: options.cancelled,
      progress: (completed, total, message) => options.progress?.(74 + completed / Math.max(1, total) * 18, message),
    });
    const minimumIndexCoverage = Math.min(3, indexResult.requested);
    if (indexResult.indices.length < minimumIndexCoverage) {
      throw new Error(`指数行情覆盖不足：${indexResult.indices.length}/${indexResult.requested}`);
    }
    const analysis = refreshAnalysis({
      ...quoted.analysis,
      source_date: date,
      indices: indexResult.indices,
      timestamp: formatDateTime(),
    });
    options.progress?.(94, '写入指数、板块与个股行情');
    await this.store.saveAnalysis(analysis, date);
    await this.audit.info('market_analysis', 'analysis_collected', {
      traceId: options.traceId,
      data: {
        date,
        blocktop_source: collected.source,
        blocks: collected.blocks,
        blocks_with_klines: collected.blocks_with_klines,
        stock_quotes: { requested: quoted.requested, loaded: quoted.loaded, rows: quoted.rows },
        indices: { requested: indexResult.requested, loaded: indexResult.indices.length, rows: indexResult.rows },
      },
    });
    return {
      analysis,
      date,
      blocks: collected.blocks,
      blocktop_source: collected.source,
      stock_quotes: quoted.loaded,
      indices: indexResult.indices.length,
      message: `已获取 blocktop ${collected.blocks} 个板块、${quoted.loaded} 只个股、${indexResult.indices.length} 个指数`,
    };
  }

  async enrichSectorTrends(
    sectorTrendsByCode: Map<string, SectorTrendLookup>,
    rankings: RankingRow[],
    date: string,
  ): Promise<Map<string, SectorTrendLookup>> {
    const missingCodes = [...new Set(
      rankings
        .map((r) => r.sector_code)
        .filter((code): code is string => !!code && !sectorTrendsByCode.has(code)),
    )];
    if (!missingCodes.length) return sectorTrendsByCode;
    await runConcurrent(missingCodes, 6, async (code) => {
      const trend = await this.store.computeSectorTrendFromBlockPrices(code, date);
      if (trend) sectorTrendsByCode.set(code, trend);
    });
    return sectorTrendsByCode;
  }

  async computeAndSaveRanking(options: {
    requestedDate: string;
    days?: number;
    traceId: string;
    rankingConfig?: RankingRuntimeConfig | null;
    cancelled?: () => boolean;
    progress?: (value: number, message: string) => void;
  }) {
    const days = normalizeBacktestDays(options.days ?? 20);
    const source = await this.store.getRankingUniverse();
    if (!source.rankings.length) throw new Error('当前股票池为空，无法获取个股行情并计算排行');
    const rankingConfig = options.rankingConfig ?? await this.store.getRankingConfig() ?? defaultRankingRuntimeConfig();
    console.log('[ranking] compute started', {
      requested_date: options.requestedDate,
      source_date: source.date,
      rows: source.rankings.length,
      factor_weights: rankingConfig.factor_weights,
      applied_backtest_run_id: rankingConfig.applied_backtest_run_id ?? null,
    });
    await this.audit.info('factor_ranking', 'ranking_started', {
      traceId: options.traceId,
      data: {
        requested_date: options.requestedDate,
        source_date: source.date,
        source_timestamp: source.timestamp,
        rows: source.rankings.length,
        factor_weights: rankingConfig.factor_weights,
        applied_backtest_run_id: rankingConfig.applied_backtest_run_id ?? null,
      },
    });
    const prepared = await this.ensureHistoricalCoverage({
      rankings: source.rankings,
      days,
      asOfDate: options.requestedDate,
      traceId: options.traceId,
      cancelled: options.cancelled ?? (() => false),
      progress: (value, message) => options.progress?.(value * 0.72, message),
    });
    if (options.cancelled?.()) return null;
    options.progress?.(76, `按 ${prepared.history.as_of_date} 行情计算截面因子`);
    const sectorTrendsByCode = await this.enrichSectorTrends(
      sectorTrendLookupMap(await this.store.getSectorTrendsForDate(prepared.history.as_of_date)),
      source.rankings,
      prepared.history.as_of_date,
    );
    const rankings = historicalCrossSectionRankings(
      prepared.history,
      prepared.history.as_of_date,
      source.rankings,
      sectorTrendsByCode,
      {
        scoringConfig: rankingConfig.scoring_config,
        factorWeights: rankingConfig.factor_weights,
      },
    );
    if (!rankings.length) throw new Error(`${prepared.history.as_of_date} 行情不足，无法生成截面排行`);
    const computed = {
      timestamp: formatDateTime(),
      date: prepared.history.as_of_date,
      total_stocks: rankings.length,
      rankings,
    };
    options.progress?.(90, '保存策略分层与全市场排名');
    await this.store.saveRanking(computed);
    await this.audit.info('factor_ranking', 'ranking_completed', {
      traceId: options.traceId,
      data: {
        ranking_date: computed.date,
        total_stocks: computed.total_stocks,
        top_rankings: computed.rankings.slice(0, 50),
        factor_weights: rankingConfig.factor_weights,
        applied_backtest_run_id: rankingConfig.applied_backtest_run_id ?? null,
        database: this.store.databasePath,
        tables: ['ranking_factor', 'stock_ranking'],
      },
    });
    return {
      date: computed.date,
      total_stocks: computed.total_stocks,
      collected: prepared.collected,
      factor_weights: rankingConfig.factor_weights,
      message: `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成 ${computed.date} 截面排行（${computed.total_stocks} 只）`,
    };
  }

  async loadPaperContextFromStore(traceId: string = randomUUID()) {
    const [analysis, ranking, history] = await Promise.all([
      this.store.getAnalysis(),
      this.store.getRanking(),
      this.store.getHistoricalMarket(),
    ]);
    const marketAverageChange = averageRankingChange(ranking.rankings);
    const limitUpRecords = (await this.store.getLimitUpByDate(ranking.date))
      .map((record) => ({ date: record.date, stock_code: record.stock_code }));
    await this.audit.info('paper_trading', 'context_loaded_from_store', {
      traceId,
      data: {
        ranking_date: ranking.date,
        rankings: ranking.rankings.length,
        calendar_days: history?.calendar?.length ?? 0,
      },
    });
    return {
      analysis: analysisWithStats(analysis),
      rankingDate: ranking.date,
      rankings: ranking.rankings,
      calendar: history?.calendar ?? [],
      marketAverageChange,
      limitUpRecords,
    };
  }

  async loadPaperContext(refreshForClose = false, traceId: string = randomUUID()) {
    const [initialAnalysis, ranking] = await Promise.all([
      this.store.getAnalysis(),
      this.store.getRankingUniverse(),
    ]);
    let analysis = initialAnalysis;
    if (refreshForClose) {
      const now = formatDateTime();
      const hourMinute = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16));
      if (hourMinute < 15 * 60) throw new Error('收盘决策只能在交易日 15:00 后运行');
      const refreshed = await this.refreshMarketAnalysis({ traceId });
      analysis = refreshed.analysis;
    }
    const targetDate = refreshForClose ? compactDate().slice(0, 8) : marketDateParam(ranking.date);
    const prepared = await this.ensureHistoricalCoverage({
      rankings: ranking.rankings,
      days: 20,
      asOfDate: targetDate,
      traceId,
      force: refreshForClose,
    });
    const history = prepared.history;
    const strategyDate = history.as_of_date;
    const sectorTrendsByCode = await this.enrichSectorTrends(
      sectorTrendLookupMap(await this.store.getSectorTrendsForDate(strategyDate)),
      ranking.rankings,
      strategyDate,
    );
    const strategyRankings = historicalCrossSectionRankings(history, strategyDate, ranking.rankings, sectorTrendsByCode);
    if (!strategyRankings.length) throw new Error(`行情已准备，但 ${strategyDate} 无法生成截面排行`);
    if (refreshForClose || ranking.date !== strategyDate) {
      await this.store.saveRanking({
        timestamp: formatDateTime(),
        date: strategyDate,
        total_stocks: strategyRankings.length,
        rankings: strategyRankings,
      });
    }
    const sectorCoverage = await this.store.getSectorTrendsForDate(strategyDate);
    if (!sectorCoverage.length) {
      const refreshed = await this.refreshMarketAnalysis({ date: strategyDate, traceId });
      analysis = refreshed.analysis;
    }
    const marketAverageChange = averageHistoricalChange(history, strategyDate) ?? averageRankingChange(strategyRankings);
    await this.audit.info('factor_ranking', 'historical_ranking_completed', {
      traceId,
      data: {
        ranking_date: strategyDate,
        rows: strategyRankings.length,
        source_stocks: history.stocks.length,
        engine: 'shared-backtest-score',
      },
    });
    const limitUpDates = [...new Set([strategyDate.replaceAll('-', '').slice(0, 8), compactDate().slice(0, 8)])];
    const limitUpRecords = (await Promise.all(limitUpDates.map((item) => this.store.getLimitUpByDate(item))))
      .flatMap((records) => records.map((record) => ({ date: record.date, stock_code: record.stock_code })));
    return {
      analysis: analysisWithStats(analysis),
      rankingDate: strategyDate,
      rankings: strategyRankings,
      calendar: history?.calendar ?? [],
      marketAverageChange,
      limitUpRecords,
    };
  }
}