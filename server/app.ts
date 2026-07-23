import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AnalysisData, BlockAnalysis, IndexAnalysis, LimitUpStock, RankingRow } from '../src/types.js';
import { AuditLogger, guardDetachedPromise, type AuditLevel } from './audit-log.js';
import { historicalCrossSectionRankings, runPolarsBacktest } from './backtest-engine.js';
import { DataStore } from './data-store.js';
import { compactDate, formatDateTime, round } from './format.js';
import {
  assessHistoricalMarketCoverage,
  collectHistoricalMarketData,
  fetchAdjustedKlines,
  fetchBlockKlines,
  fetchBlockTop,
  type BlockKlinePeriod,
  type BlockTopData,
  type HistoricalMarketData,
  type KLineData,
} from './historical-market.js';
import { PAPER_ENGINE_VERSION, PaperTradingService } from './paper-trading.js';
import { queryRankings, refreshAnalysis } from './polars-engine.js';
import { analyzeBlockTrend, blockStrategy, classifyMarketState, klinesToBars } from './scoring-engine.js';
import { TaskRegistry } from './tasks.js';
import { ThsSimulatedBroker, ThsSimulatedBrokerError } from './ths-simulated-broker.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (handler: AsyncHandler) => (request: Request, response: Response, next: NextFunction) => {
  void handler(request, response, next).catch(next);
};

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

function analysisWithStats(data: AnalysisData): AnalysisData {
  const enriched = refreshAnalysis(data);
  return { ...enriched, timestamp: data.timestamp };
}

function buildBlockAnalysis(
  block: BlockTopData,
  daily: KLineData[],
  weekly: KLineData[],
  monthly: KLineData[],
): BlockAnalysis {
  const trend = analyzeBlockTrend(klinesToBars(daily), klinesToBars(weekly), klinesToBars(monthly));
  const strategy = blockStrategy(trend.state_id, block.limit_up_num, block.continuous_plate_num);
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
    },
    strategy: { action: strategy.action, label: strategy.label, position: strategy.position },
    stock_list: stockList,
  };
}

/**
 * 涨停采集 → 板块 K 线 → 趋势分类 → 情绪重算的完整流水线（ref-doc §1/§3）。
 * 保留现有 indices，仅重建 blocks 与 sentiment；同花顺不可用时返回空块并保留原分析。
 */
async function collectLimitUpAnalysis(
  base: AnalysisData,
  date: string,
  options: { progress?: (pct: number, message: string) => void; cancelled?: () => boolean; concurrency?: number } = {},
): Promise<{ analysis: AnalysisData; blocks: number; blocks_with_klines: number; source: 'ths-limit-up' | 'none' }> {
  const { blocks: tops, source } = await fetchBlockTop(date);
  if (!tops.length) return { analysis: base, blocks: 0, blocks_with_klines: 0, source };
  const results: BlockAnalysis[] = [];
  let cursor = 0;
  let done = 0;
  let blocksWithKlines = 0;
  const concurrency = Math.min(6, Math.max(1, options.concurrency ?? 4));
  const worker = async () => {
    while (true) {
      if (options.cancelled?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= tops.length) return;
      const block = tops[index];
      const [daily, weekly, monthly] = await Promise.all([
        fetchBlockKlines(block.code, '01', 250),
        fetchBlockKlines(block.code, '11', 120),
        fetchBlockKlines(block.code, '21', 120),
      ]);
      const throughDate = (kline: KLineData) => marketDateParam(kline.date, '') <= date;
      const dailyKlines = daily.klines.filter(throughDate);
      const weeklyKlines = weekly.klines.filter(throughDate);
      const monthlyKlines = monthly.klines.filter(throughDate);
      if (dailyKlines.length >= 20) blocksWithKlines += 1;
      results.push(buildBlockAnalysis(block, dailyKlines, weeklyKlines, monthlyKlines));
      done += 1;
      options.progress?.(done / tops.length * 100, `板块趋势分类 ${done}/${tops.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tops.length) }, () => worker()));
  results.sort((left, right) => right.block_info.limit_up_num - left.block_info.limit_up_num);
  const analysis: AnalysisData = { ...base, timestamp: formatDateTime(), blocks: results };
  return { analysis: refreshAnalysis(analysis), blocks: results.length, blocks_with_klines: blocksWithKlines, source };
}

async function refreshBlockStockQuotes(
  analysis: AnalysisData,
  date: string,
  store: DataStore,
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
      rows += await store.upsertStockPrices(stock.code, stock.name, marketData.klines);
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

function priceRows(klines: KLineData[]) {
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

function averageRankingChange(rankings: Array<{ latest_change_rate?: number | null }>): number | undefined {
  const values = rankings.flatMap((row) => {
    if (row.latest_change_rate == null) return [];
    const value = Number(row.latest_change_rate);
    return Number.isFinite(value) ? [value] : [];
  });
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function averageHistoricalChange(history: HistoricalMarketData, date: string): number | undefined {
  const target = date.replaceAll('-', '').slice(0, 8);
  const values = history.stocks.flatMap((stock) => {
    const bar = [...stock.bars].reverse().find((item) => item[0] <= target);
    return bar && Number.isFinite(Number(bar[7])) ? [Number(bar[7])] : [];
  });
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
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

async function refreshIndexAnalysis(
  date: string,
  store: DataStore,
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
      rows += await store.upsertIndexPrices(symbol, indexName(symbol), marketData.klines);
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

export interface AppServices {
  store: DataStore;
  tasks: TaskRegistry;
  paper: PaperTradingService;
  audit: AuditLogger;
}

export function createApp(services: Partial<AppServices> = {}) {
  const store = services.store ?? new DataStore();
  const audit = services.audit ?? new AuditLogger(path.join(store.runtime, 'logs'));
  const tasks = services.tasks ?? new TaskRegistry(audit);
  let historicalPreparationInFlight: Promise<HistoricalMarketData> | null = null;

  const ensureHistoricalCoverage = async (options: {
    rankings: RankingRow[];
    days: number;
    asOfDate: string;
    traceId: string;
    force?: boolean;
    cancelled?: () => boolean;
    progress?: (value: number, message: string) => void;
  }): Promise<{ history: HistoricalMarketData; collected: boolean }> => {
    const requestedDate = marketDateParam(options.asOfDate);
    let history = await store.getHistoricalMarket();
    let coverage = assessHistoricalMarketCoverage(history, options.rankings, { days: options.days, asOfDate: requestedDate });
    await audit.info('market_data', 'coverage_checked', {
      traceId: options.traceId,
      data: coverage,
    });
    if (!options.force && coverage.usable && history) {
      options.progress?.(20, `行情覆盖已满足：${coverage.covered_stocks}/${coverage.universe_size} 只`);
      await audit.info('market_data', 'snapshot_cache_hit', {
        traceId: options.traceId,
        data: { ...coverage, generated_at: history.generated_at },
      });
      return { history, collected: false };
    }

    if (historicalPreparationInFlight) {
      options.progress?.(8, '等待正在进行的个股行情采集');
      await historicalPreparationInFlight;
      history = await store.getHistoricalMarket();
      coverage = assessHistoricalMarketCoverage(history, options.rankings, { days: options.days, asOfDate: requestedDate });
      if (!options.force && coverage.usable && history) return { history, collected: false };
    }

    options.progress?.(3, `覆盖不足，开始获取 ${requestedDate} 前 ${options.days} 日个股行情`);
    const collection = (async () => {
      const result = await collectHistoricalMarketData(options.rankings, {
        days: options.days,
        asOfDate: requestedDate,
        cancelled: options.cancelled,
        audit,
        traceId: options.traceId,
        progress: (completed, total, message) => options.progress?.(8 + completed / total * 82, message),
      });
      if (!result) throw new Error('个股行情采集未完成');
      await store.saveHistoricalMarket(result);
      const persisted = await store.getHistoricalMarket() ?? result;
      await audit.info('market_data', 'snapshot_saved', {
        traceId: options.traceId,
        data: {
          database: store.databasePath,
          tables: ['stock_daily_price', 'index_daily_price', 'historical_snapshot'],
          as_of_date: persisted.as_of_date,
          stocks: persisted.stocks.length,
          failed_stocks: persisted.failed_stocks,
        },
      });
      return persisted;
    })();
    historicalPreparationInFlight = collection;
    try {
      history = await collection;
    } finally {
      if (historicalPreparationInFlight === collection) historicalPreparationInFlight = null;
    }

    coverage = assessHistoricalMarketCoverage(history, options.rankings, { days: options.days, asOfDate: requestedDate });
    await audit.info('market_data', 'coverage_verified', {
      traceId: options.traceId,
      data: coverage,
    });
    if (!coverage.usable) throw new Error(`个股行情仍不能覆盖需求日期段：${coverage.reasons.join('；')}`);
    options.progress?.(94, `行情覆盖校验通过：${coverage.covered_stocks}/${coverage.universe_size} 只`);
    return { history, collected: true };
  };

  const refreshMarketAnalysis = async (options: {
    date: string;
    traceId: string;
    cancelled?: () => boolean;
    progress?: (value: number, message: string) => void;
  }) => {
    const date = marketDateParam(options.date);
    const base = await store.getAnalysis();
    options.progress?.(4, `获取 ${date} 同花顺 blocktop`);
    const collected = await collectLimitUpAnalysis(base, date, {
      cancelled: options.cancelled,
      progress: (pct, message) => options.progress?.(8 + pct * 0.38, message),
    });
    if (!collected.blocks) {
      await audit.warn('market_analysis', 'limit_up_collection_empty', {
        traceId: options.traceId,
        data: { date, source: collected.source },
      });
      throw new Error('同花顺 blocktop 数据不可用，已保留现有分析快照');
    }
    const minimumBlockCoverage = Math.min(collected.blocks, Math.max(1, Math.floor(collected.blocks * 0.2)));
    if (collected.blocks_with_klines < minimumBlockCoverage) {
      throw new Error(`板块 K 线覆盖不足：${collected.blocks_with_klines}/${collected.blocks}`);
    }
    if (options.cancelled?.()) throw new Error('分析刷新已停止');

    const quoted = await refreshBlockStockQuotes(collected.analysis, date, store, {
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

    const indexResult = await refreshIndexAnalysis(date, store, {
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
    await store.saveAnalysis(analysis, date);
    await audit.info('market_analysis', 'analysis_collected', {
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
  };

  const loadPaperContext = async (refreshForClose = false, traceId: string = randomUUID()) => {
    const [initialAnalysis, ranking] = await Promise.all([
      store.getAnalysis(),
      store.getRankingUniverse(),
    ]);
    let analysis = initialAnalysis;
    if (refreshForClose) {
      const now = formatDateTime();
      const hourMinute = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16));
      if (hourMinute < 15 * 60) throw new Error('收盘决策只能在交易日 15:00 后运行');
      const refreshed = await refreshMarketAnalysis({ date: compactDate().slice(0, 8), traceId });
      analysis = refreshed.analysis;
    }
    const targetDate = refreshForClose ? compactDate().slice(0, 8) : marketDateParam(ranking.date);
    const prepared = await ensureHistoricalCoverage({
      rankings: ranking.rankings,
      days: 20,
      asOfDate: targetDate,
      traceId,
      force: refreshForClose,
    });
    const history = prepared.history;
    const strategyDate = history.as_of_date;
    const strategyRankings = historicalCrossSectionRankings(history, strategyDate, ranking.rankings);
    if (!strategyRankings.length) throw new Error(`行情已准备，但 ${strategyDate} 无法生成截面排行`);
    if (refreshForClose || ranking.date !== strategyDate) {
      await store.saveRanking({
        timestamp: formatDateTime(),
        date: strategyDate,
        total_stocks: strategyRankings.length,
        rankings: strategyRankings,
      });
    }
    const sectorCoverage = await store.getSectorTrendsForDate(strategyDate);
    if (!sectorCoverage.length) {
      const refreshed = await refreshMarketAnalysis({ date: strategyDate, traceId });
      analysis = refreshed.analysis;
    }
    const marketAverageChange = averageHistoricalChange(history, strategyDate) ?? averageRankingChange(strategyRankings);
    await audit.info('factor_ranking', 'historical_ranking_completed', {
      traceId,
      data: {
        ranking_date: strategyDate,
        rows: strategyRankings.length,
        source_stocks: history.stocks.length,
        engine: 'shared-backtest-score',
      },
    });
    const limitUpDates = [...new Set([strategyDate.replaceAll('-', '').slice(0, 8), compactDate().slice(0, 8)])];
    const limitUpRecords = (await Promise.all(limitUpDates.map((item) => store.getLimitUpByDate(item))))
      .flatMap((records) => records.map((record) => ({ date: record.date, stock_code: record.stock_code })));
    return {
      analysis: analysisWithStats(analysis),
      rankingDate: strategyDate,
      rankings: strategyRankings,
      calendar: history?.calendar ?? [],
      marketAverageChange,
      limitUpRecords,
    };
  };
  const paper = services.paper ?? new PaperTradingService(new ThsSimulatedBroker({ audit }), {
    stateStore: {
      load: () => store.getPaperTradingState(),
      save: (state) => store.savePaperTradingState(state),
    },
    marketDataProvider: (window, traceId) => loadPaperContext(window === 'close', traceId),
    audit,
  });
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((request, response, next) => {
    const supplied = String(request.headers['x-trace-id'] ?? '').trim();
    const traceId = /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
    response.locals.traceId = traceId;
    response.setHeader('x-trace-id', traceId);
    const started = Date.now();
    guardDetachedPromise(audit.info('http', 'request_started', {
      traceId,
      data: { method: request.method, path: request.path, query: request.query },
    }), 'http', 'request_started');
    response.on('finish', () => {
      guardDetachedPromise(audit.info('http', 'request_completed', {
        traceId,
        durationMs: Date.now() - started,
        data: { method: request.method, path: request.path, status: response.statusCode },
      }), 'http', 'request_completed');
    });
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      service: 'trending-polars',
      stack: ['React', 'Tailwind CSS', 'Express', 'nodejs-polars', 'node:sqlite'],
      storage: store.getStorageStatus(),
      timestamp: formatDateTime(),
    });
  });

  app.get('/api/analysis', asyncHandler(async (request, response) => {
    if (String(request.query.refresh ?? '0') === '1') {
      const date = marketDateParam(request.query.date);
      const task = tasks.start('analysis_fetch', '刷新指数、板块与个股行情', ({ progress, cancelled, traceId }) => (
        refreshMarketAnalysis({ date, progress, cancelled, traceId })
      ));
      response.status(202).json({ task_id: task.id, status: 'started', message: '分析任务已启动' });
      return;
    }
    response.json(analysisWithStats(await store.getAnalysis()));
  }));

  app.post('/api/analysis/collect', asyncHandler(async (request, response) => {
    const date = marketDateParam(request.query.date);
    const task = tasks.start('analysis_collect', '采集指数、板块与个股行情', ({ progress, cancelled, traceId }) => (
      refreshMarketAnalysis({ date, progress, cancelled, traceId })
    ));
    response.status(202).json({ task_id: task.id, status: 'started', message: '涨停采集任务已启动' });
  }));

  app.get('/api/limit_up', asyncHandler(async (request, response) => {
    const date = String(request.query.date || await store.getLatestAnalysisDate() || compactDate().slice(0, 8));
    response.json(await store.getLimitUpByDate(date));
  }));

  app.get('/api/klines', asyncHandler(async (request, response) => {
    const symbol = String(request.query.symbol ?? '').trim().toLowerCase();
    if (!/^(sh|sz)\d{6}$/.test(symbol)) {
      response.status(400).json({ error: 'symbol 必须是 sh/sz 加 6 位代码' });
      return;
    }
    const limit = numberParam(request.query.limit, 120, 1, 1000);
    const marketData = await fetchAdjustedKlines(symbol, limit);
    let source: string = marketData.source;
    let klines = marketData.klines;
    if (klines.length) {
      await store.upsertIndexPrices(symbol, indexName(symbol), klines);
    } else {
      klines = await store.getIndexPrices(symbol, limit);
      if (klines.length) source = 'sqlite';
    }
    response.setHeader('x-market-data-source', source);
    response.json({ symbol, klines, count: klines.length, source });
  }));

  app.get('/api/stock_prices', asyncHandler(async (request, response) => {
    const stockCode = String(request.query.stock_code ?? request.query.symbol ?? '').trim().toLowerCase();
    const code = stockCode.replace(/^(sh|sz)/, '');
    if (!/^\d{6}$/.test(code)) {
      response.json([]);
      return;
    }
    const limit = numberParam(request.query.limit, 60, 1, 250);
    const symbol = /^(sh|sz)\d{6}$/.test(stockCode)
      ? stockCode
      : `${/^(6|68|5|9)/.test(code) ? 'sh' : 'sz'}${code}`;
    const marketData = await fetchAdjustedKlines(symbol, limit);
    let source: string = marketData.source;
    let klines = marketData.klines;
    if (klines.length) {
      await store.upsertStockPrices(code, await store.getStockName(code) ?? code, klines);
    } else {
      klines = await store.getStockPrices(code, limit);
      if (klines.length) source = 'sqlite';
    }
    response.setHeader('x-market-data-source', source);
    response.json(priceRows(klines));
  }));

  app.get('/api/index_prices', asyncHandler(async (request, response) => {
    const requested = String(request.query.symbol ?? request.query.index_code ?? '').trim().toLowerCase();
    const code = requested.replace(/^(sh|sz)/, '');
    if (!/^\d{6}$/.test(code)) {
      response.status(400).json({ error: 'symbol/index_code is required' });
      return;
    }
    // 中证/上证指数常用 000xxx，深证指数常用 399xxx/980xxx；显式前缀优先。
    const symbol = /^(sh|sz)\d{6}$/.test(requested)
      ? requested
      : `${/^(399|980)/.test(code) ? 'sz' : 'sh'}${code}`;
    const limit = numberParam(request.query.limit, 120, 1, 1000);
    const marketData = await fetchAdjustedKlines(symbol, limit);
    let source: string = marketData.source;
    let klines = marketData.klines;
    if (klines.length) {
      await store.upsertIndexPrices(symbol, indexName(symbol), klines);
    } else {
      klines = await store.getIndexPrices(symbol, limit);
      if (klines.length) source = 'sqlite';
    }
    response.setHeader('x-market-data-source', source);
    response.json(priceRows(klines));
  }));

  app.get('/api/block_prices', asyncHandler(async (request, response) => {
    const blockCode = String(request.query.block_code ?? request.query.code ?? '').trim();
    if (!/^(?:bk[_-]?)?\d{6}$/i.test(blockCode)) {
      response.status(400).json({ error: 'block_code is required' });
      return;
    }
    const requestedPeriod = String(request.query.period ?? '01');
    if (!['01', '11', '21'].includes(requestedPeriod)) {
      response.status(400).json({ error: 'period 必须是 01（日）、11（周）或 21（月）' });
      return;
    }
    const limit = numberParam(request.query.limit, 120, 1, 1000);
    const marketData = await fetchBlockKlines(blockCode, requestedPeriod as BlockKlinePeriod, limit);
    response.setHeader('x-market-data-source', marketData.source);
    if (marketData.name) response.setHeader('x-market-data-name', encodeURIComponent(marketData.name));
    response.json(priceRows(marketData.klines));
  }));

  app.get('/api/ranking', asyncHandler(async (request, response) => {
    const source = await store.getRanking();
    response.json(queryRankings(source, {
      search: String(request.query.search ?? ''),
      action: String(request.query.action ?? 'all'),
      sector: String(request.query.sector ?? 'all'),
      sort: String(request.query.sort ?? 'total_score'),
      order: String(request.query.order ?? 'desc'),
      page: numberParam(request.query.page, 1, 1, 100_000),
      pageSize: numberParam(request.query.page_size, 50, 5, 200),
    }));
  }));

  app.post('/api/ranking/compute', asyncHandler(async (request, response) => {
    const requestedDate = marketDateParam(request.query.date);
    const days = numberParam(request.query.days, 20, 5, 60);
    const task = tasks.start('ranking_compute', '计算多因子排行榜', async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法获取个股行情并计算排行');
      await audit.info('factor_ranking', 'ranking_started', {
        traceId,
        data: { requested_date: requestedDate, source_date: source.date, source_timestamp: source.timestamp, rows: source.rankings.length },
      });
      const prepared = await ensureHistoricalCoverage({
        rankings: source.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.72, message),
      });
      if (cancelled()) return null;
      progress(76, `按 ${prepared.history.as_of_date} 行情计算截面因子`);
      const rankings = historicalCrossSectionRankings(prepared.history, prepared.history.as_of_date, source.rankings);
      if (!rankings.length) throw new Error(`${prepared.history.as_of_date} 行情不足，无法生成截面排行`);
      const computed = {
        timestamp: formatDateTime(),
        date: prepared.history.as_of_date,
        total_stocks: rankings.length,
        rankings,
      };
      progress(90, '保存策略分层与全市场排名');
      await store.saveRanking(computed);
      await audit.info('factor_ranking', 'ranking_completed', {
        traceId,
        data: {
          ranking_date: computed.date,
          total_stocks: computed.total_stocks,
          top_rankings: computed.rankings.slice(0, 50),
          database: store.databasePath,
          tables: ['ranking_factor', 'stock_ranking'],
        },
      });
      return {
        date: computed.date,
        total_stocks: computed.total_stocks,
        collected: prepared.collected,
        message: `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成 ${computed.date} 截面排行（${computed.total_stocks} 只）`,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '排行计算已启动' });
  }));

  app.get('/api/tasks', (request, response) => {
    const limit = numberParam(request.query.limit, 50, 1, 500);
    const recent = tasks.recent(limit, true);
    response.json({ total: recent.length, tasks: recent });
  });

  app.get('/api/tasks/:taskId', (request, response) => {
    const task = tasks.get(request.params.taskId);
    if (!task) {
      response.status(404).json({ error: 'task not found' });
      return;
    }
    response.json(task);
  });

  app.post('/api/tasks/:taskId/cancel', (request, response) => {
    response.json({ success: tasks.cancel(request.params.taskId), task_id: request.params.taskId });
  });

  app.post('/api/backtest/collect', asyncHandler(async (request, response) => {
    const days = numberParam(request.query.days, 20, 5, 60);
    const requestedDate = marketDateParam(request.query.date);
    const task = tasks.start('backtest_collect', `构建近 ${days} 日历史样本`, async ({ progress, cancelled, traceId }) => {
      const ranking = await store.getRankingUniverse();
      if (!ranking.rankings.length) throw new Error('当前股票池为空，无法采集回测行情');
      const prepared = await ensureHistoricalCoverage({
        rankings: ranking.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        force: true,
        cancelled,
        progress,
      });
      if (cancelled()) return null;
      return {
        days,
        stocks: prepared.history.stocks.length,
        failed_stocks: prepared.history.failed_stocks,
        as_of_date: prepared.history.as_of_date,
        source: prepared.history.source,
        status: 'ready',
        message: `已获取并校验 ${prepared.history.as_of_date} 前 ${days} 日行情（${prepared.history.stocks.length} 只）`,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '采集任务已启动' });
  }));

  app.post('/api/backtest/run', asyncHandler(async (request, response) => {
    const days = numberParam(request.query.days, 20, 5, 60);
    const maxHoldDays = numberParam(request.query.max_hold_days, 5, 1, 60);
    const requestedDate = marketDateParam(request.query.date);
    const task = tasks.start('backtest_run', `运行 ${days} 日策略回测`, async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法运行回测');
      const prepared = await ensureHistoricalCoverage({
        rankings: source.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.58, message),
      });
      if (cancelled()) return null;
      const history = prepared.history;
      await audit.info('backtest', 'run_started', {
        traceId,
        data: { days, max_hold_days: maxHoldDays, history_as_of_date: history.as_of_date, stocks: history.stocks.length },
      });
      progress(62, '按当日收盘生成信号，次日开盘成交');
      const result = runPolarsBacktest(history, { days, maxHoldDays });
      progress(88, '汇总含交易成本的收益、胜率与回撤');
      await store.saveBacktest(result);
      await audit.info('backtest', 'run_completed', {
        traceId,
        data: {
          run_id: result.run_id,
          summary: result.summary,
          config: result.config,
          trades: result.trades,
          output_path: path.join(store.runtime, 'backtests', `${result.run_id}.json`),
        },
      });
      return {
        run_id: result.run_id,
        summary: result.summary,
        collected: prepared.collected,
        message: `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成 ${result.date_range} 回测`,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '回测任务已启动' });
  }));

  app.get('/api/backtest/list', asyncHandler(async (_request, response) => {
    response.json(await store.listBacktests());
  }));

  app.get('/api/backtest/:runId', asyncHandler(async (request, response) => {
    const runId = String(request.params.runId);
    const result = await store.getBacktest(runId);
    if (!result) {
      response.status(404).json({ error: 'not found', run_id: runId });
      return;
    }
    response.json(result);
  }));

  app.delete('/api/backtest/:runId', asyncHandler(async (request, response) => {
    const runId = String(request.params.runId);
    response.json({ success: await store.deleteBacktest(runId), run_id: runId });
  }));

  app.use('/api/simulated-trading', (_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });

  app.get('/api/simulated-trading/health', (_request, response) => {
    response.json({
      ok: true,
      mode: 'simulated',
      source: 'tonghuashun-gui',
      account_source: 'tonghuashun-gui',
      execution_tool: 'applescript',
      trading_core: 'nodejs',
      engine_version: PAPER_ENGINE_VERSION,
      service: 'node-polars-ths-simulated-trading',
    });
  });

  app.get('/api/simulated-trading/bootstrap', asyncHandler(async (_request, response) => {
    const traceId = String(response.locals.traceId);
    // 只读取 Node 本地状态和排行快照，不触碰同花顺；页面可以先用这份状态渲染，
    // 随后的 overview 请求再在浏览器后台完成实时账户同步。
    const [analysis, ranking] = await Promise.all([store.getAnalysis(), store.getRanking()]);
    const marketAverageChange = averageRankingChange(ranking.rankings);
    const limitUpRecords = (await store.getLimitUpByDate(ranking.date))
      .map((record) => ({ date: record.date, stock_code: record.stock_code }));
    const [overview, automation] = await Promise.all([
      paper.cachedOverview(analysisWithStats(analysis), ranking.date, ranking.rankings, [], traceId, marketAverageChange, limitUpRecords),
      paper.getAutomation(),
    ]);
    response.json({ overview, automation: automation.automation });
  }));

  app.get('/api/simulated-trading/overview', asyncHandler(async (_request, response) => {
    const traceId = String(response.locals.traceId);
    const context = await loadPaperContext(false, traceId);
    response.json(await paper.overview(
      context.analysis,
      context.rankingDate,
      context.rankings,
      context.calendar,
      traceId,
      context.marketAverageChange,
      context.limitUpRecords,
    ));
  }));

  app.get('/api/simulated-trading/automation', asyncHandler(async (_request, response) => {
    response.json(await paper.getAutomation());
  }));

  app.get('/api/simulated-trading/state', asyncHandler(async (_request, response) => {
    response.json(await paper.getRuntimeState());
  }));

  app.post('/api/simulated-trading/automation/toggle', asyncHandler(async (request, response) => {
    response.json(await paper.toggle(Boolean(request.body?.enabled), String(response.locals.traceId)));
  }));

  app.post('/api/simulated-trading/automation/pause-today', asyncHandler(async (_request, response) => {
    response.json(await paper.pause(true, String(response.locals.traceId)));
  }));

  app.post('/api/simulated-trading/automation/resume', asyncHandler(async (_request, response) => {
    response.json(await paper.pause(false, String(response.locals.traceId)));
  }));

  app.post('/api/simulated-trading/automation/run-window', asyncHandler(async (request, response) => {
    const requestedWindow = String(request.body?.window ?? 'open');
    if (!['open', 'near_close', 'close', 'post_close'].includes(requestedWindow)) {
      response.status(400).json({ ok: false, error: '交易窗口必须是 open、near_close、close 或 post_close' });
      return;
    }
    try {
      response.json(await paper.runWindowConfirmed(
        requestedWindow as 'open' | 'near_close' | 'close' | 'post_close',
        await loadPaperContext(requestedWindow === 'close', String(response.locals.traceId)),
        String(response.locals.traceId),
      ));
    } catch (error) {
      await audit.error('paper_trading', 'manual_window_failed', {
        traceId: String(response.locals.traceId),
        data: { window: requestedWindow },
        error,
      });
      response.status(error instanceof ThsSimulatedBrokerError ? 409 : 400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  app.post('/api/simulated-trading/execute', asyncHandler(async (request, response) => {
    try {
      const traceId = String(response.locals.traceId);
      response.json(await paper.execute(await loadPaperContext(false, traceId), traceId));
    } catch (error) {
      await audit.error('paper_trading', 'manual_execute_failed', {
        traceId: String(response.locals.traceId),
        error,
      });
      response.status(error instanceof ThsSimulatedBrokerError ? 409 : 400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  app.post('/api/simulated-trading/cancel', asyncHandler(async (request, response) => {
    try {
      response.json(await paper.cancel(String(request.body?.confirmation ?? ''), String(request.body?.order_id ?? ''), {
        stock_code: request.body?.stock_code ? String(request.body.stock_code) : undefined,
        quantity: request.body?.quantity ? Number(request.body.quantity) : undefined,
        side: request.body?.side === 'sell' ? 'sell' : request.body?.side === 'buy' ? 'buy' : undefined,
      }, String(response.locals.traceId)));
    } catch (error) {
      await audit.error('paper_trading', 'cancel_failed', {
        traceId: String(response.locals.traceId),
        error,
      });
      response.status(error instanceof ThsSimulatedBrokerError ? 409 : 400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  app.post('/api/simulated-trading/monitor/run', asyncHandler(async (_request, response) => {
    try {
      response.json(await paper.monitorAccount(String(response.locals.traceId), 'manual_monitor'));
    } catch (error) {
      await audit.error('account_monitor', 'manual_monitor_failed', {
        traceId: String(response.locals.traceId),
        error,
      });
      response.status(error instanceof ThsSimulatedBrokerError ? 409 : 400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }));

  app.get('/api/audit/logs', asyncHandler(async (request, response) => {
    const level = String(request.query.level ?? '');
    response.json({
      logs: await audit.query({
        limit: numberParam(request.query.limit, 200, 1, 5_000),
        date: request.query.date ? String(request.query.date) : undefined,
        level: ['debug', 'info', 'warn', 'error'].includes(level) ? level as AuditLevel : undefined,
        component: request.query.component ? String(request.query.component) : undefined,
        event: request.query.event ? String(request.query.event) : undefined,
        traceId: request.query.trace_id ? String(request.query.trace_id) : undefined,
        search: request.query.search ? String(request.query.search) : undefined,
      }),
    });
  }));

  app.get('/api/audit/files', asyncHandler(async (_request, response) => {
    response.json({ files: await audit.files(), retention_days: 30 });
  }));

  const distDir = path.resolve(MODULE_DIR, '..', 'dist');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/') || request.path.startsWith('/ws/')) {
        next();
        return;
      }
      response.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    guardDetachedPromise(audit.error('http', 'request_failed', {
      traceId: String(response.locals.traceId ?? ''),
      data: { status: error instanceof ThsSimulatedBrokerError ? 409 : 500 },
      error,
    }), 'http', 'request_failed');
    response.status(error instanceof ThsSimulatedBrokerError ? 409 : 500).json({ error: message });
  });

  return { app, services: { store, tasks, paper, audit } };
}
