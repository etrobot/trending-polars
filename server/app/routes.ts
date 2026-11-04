import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AnalysisData } from '../../src/types.js';
import { guardDetachedPromise, type AuditLevel, type AuditLoggerLike } from '../audit-log.js';
import { MAX_FACTOR_WEIGHT_PCT, runPolarsBacktest, runRandomizedBacktest } from '../backtest-engine.js';
import { runOverfitAnalysis } from '../backtest-overfit.js';
import { optimizeStrategyParams } from '../backtest-param-optimizer.js';
import { computeFactorIC } from '../factor-ic.js';
import { fetchSohuIndexKlines, buildBenchmarkCurve } from '../benchmark.js';
import { compactDate, formatDateTime, round } from '../format.js';
import { fetchAdjustedKlines, fetchBlockKlines, fetchBlockYearKlines, MAX_BACKTEST_DAYS, MIN_BACKTEST_DAYS, type BlockKlinePeriod } from '../historical-market.js';
import { queryRankings } from '../polars-engine.js';
import { normalizeScoreStockConfig } from '../scoring-engine.js';
import { rankingConfigFromBacktest, type RankingRuntimeConfig } from '../ranking-config.js';
import type { TaskRegistry } from '../tasks.js';
import { ThsSimulatedBrokerError } from '../ths-simulated-broker.js';
import { MarketService, analysisWithStats, priceRows, averageRankingChange } from './market-service.js';
import { buildInstanceConfig, MiningInstanceStore, type MiningDeployRequest } from '../pipeline/deploy.js';
import { readInstanceState } from '../pipeline/instance.js';
import { computeFrictionStats } from '../pipeline/friction.js';
import { replayMiningRun } from '../pipeline/replay.js';
import { MiningStore } from '../pipeline/store.js';
import { buildValidationReport, computeActualMetrics } from '../pipeline/validation.js';
import { resolveLatestTradingDate, loadTradingCalendar } from '../index-bootstrap.js';
import { PAPER_ENGINE_VERSION, type PaperTradingService } from '../paper-trading.js';
import { buildTradingSession, immediateAutoWindowRejection, resolveAutoTradingWindow, shanghaiClock } from '../paper-trading/helpers.js';
import {
  buildSectorRotation,
  CONCEPT_BLOCK_PREFIXES,
  isIndustryBlockCode,
  RECENT_LIMIT_UP_DAYS,
} from '../sector-rotation.js';

// ---------------------------------------------------------------------------
// Helper types and functions
// ---------------------------------------------------------------------------

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

/** 板块轮动按年补采记录：同一进程内每个「年份+板块」只尝试一次，避免每次请求重复联网。 */
const backfillAttempted = new Set<string>();

function parseScoringConfig(value: unknown): ReturnType<typeof normalizeScoreStockConfig> | undefined {
  if (value == null) return undefined;
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== 'object' || raw == null) return undefined;
  return normalizeScoreStockConfig(raw as Parameters<typeof normalizeScoreStockConfig>[0]);
}

function readScoringConfig(request: Request): ReturnType<typeof normalizeScoreStockConfig> | undefined {
  const fromQuery = parseScoringConfig((request.query as Record<string, unknown>).scoring_config);
  if (fromQuery) return fromQuery;
  const body = (request.body ?? {}) as { scoring_config?: unknown };
  return parseScoringConfig(body.scoring_config);
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
// Route registration
// ---------------------------------------------------------------------------

export function registerRoutes(
  app: express.Express,
  services: {
    store: import('../data-store.js').DataStore;
    tasks: TaskRegistry;
    paper: PaperTradingService;
    audit: AuditLoggerLike;
  },
  marketService: MarketService,
  MODULE_DIR: string,
): void {
  const { store, audit, tasks, paper } = services;

  // Middleware
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

  const startRankingTask = (
    requestedDate: string,
    days: number,
    name = '计算多因子排行榜',
    rankingConfig?: RankingRuntimeConfig,
  ) => tasks.start('ranking_compute', name, async ({ progress, cancelled, traceId }) => {
    const source = await store.getRankingUniverse();
    if (!source.rankings.length) throw new Error('当前股票池为空，无法获取个股行情并计算排行');
    return marketService.computeAndSaveRanking({
      requestedDate,
      days,
      traceId,
      rankingConfig,
      cancelled,
      progress,
    });
  });

  // Health
  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      service: 'trending-polars',
      stack: ['React', 'Tailwind CSS', 'Express', 'nodejs-polars', 'node:sqlite'],
      storage: store.getStorageStatus(),
      timestamp: formatDateTime(),
    });
  });

  // Analysis
  app.get('/api/analysis', asyncHandler(async (request, response) => {
    if (String(request.query.refresh ?? '0') === '1') {
      const task = tasks.start('analysis_fetch', '刷新指数、板块与个股行情', ({ progress, cancelled, traceId }) => (
        marketService.refreshMarketAnalysis({ date: String(request.query.date ?? ''), progress, cancelled, traceId })
      ));
      response.status(202).json({ task_id: task.id, status: 'started', message: '分析任务已启动' });
      return;
    }
    response.json(analysisWithStats(await store.getAnalysis()));
  }));

  app.post('/api/analysis/collect', asyncHandler(async (request, response) => {
    const task = tasks.start('analysis_collect', '采集指数、板块与个股行情', ({ progress, cancelled, traceId }) => (
      marketService.refreshMarketAnalysis({ date: String(request.query.date ?? ''), progress, cancelled, traceId })
    ));
    response.status(202).json({ task_id: task.id, status: 'started', message: '涨停采集任务已启动' });
  }));

  app.get('/api/limit_up', asyncHandler(async (request, response) => {
    const date = await resolveLatestTradingDate(
      store,
      request.query.date || await store.getLatestAnalysisDate() || compactDate().slice(0, 8),
    );
    response.json(await store.getLimitUpByDate(date));
  }));

  // 板块个股：列出数据库内该板块累积去重的全部个股
  app.get('/api/sector-stocks', asyncHandler(async (request, response) => {
    const sectorCode = String(request.query.sector_code ?? '').trim();
    if (!sectorCode) {
      response.status(400).json({ error: 'sector_code 不能为空' });
      return;
    }
    const stocks = await store.getSectorStocks(sectorCode);
    response.json({
      sector_code: sectorCode,
      sector_name: stocks[0]?.sector_name ?? '',
      stock_count: stocks.length,
      latest_analysis_date: stocks[0]?.latest_analysis_date ?? '',
      fresh_count: stocks.filter((stock) => stock.price_fresh).length,
      stocks: stocks.map((stock) => ({
        code: stock.stock_code,
        name: stock.stock_name,
        latest_date: stock.date,
        continue_num: stock.continue_num,
        reason_type: stock.reason_type,
        // 涨停当时的价格（仍可作为「当时连板价」参考列）
        latest: stock.latest,
        change_rate: stock.change_rate,
        // 当前 K 线最新数据（仅当 price_fresh 时反映当下行情）
        kline_date: stock.kline_date,
        kline_latest: stock.kline_latest,
        kline_change_rate: stock.kline_change_rate,
        price_fresh: stock.price_fresh,
      })),
    });
  }));

  // 异步刷新该板块全部个股的 K 线
  app.post('/api/sector-stocks/refresh-kline', asyncHandler(async (request, response) => {
    const sectorCode = String(request.query.sector_code ?? '').trim();
    if (!sectorCode) {
      response.status(400).json({ error: 'sector_code 不能为空' });
      return;
    }
    const task = tasks.start('sector_kline_refresh', `板块个股K线刷新 ${sectorCode}`, async ({ progress, cancelled }) => (
      marketService.refreshSectorStockKlines(sectorCode, {
        progress: (completed, total, message) => progress(Math.round((completed / total) * 100), message),
        cancelled,
      })
    ));
    response.status(202).json({ task_id: task.id, status: 'started', message: '板块个股K线刷新任务已启动' });
  }));

  // Klines
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

  // 板块轮动：今年 YTD 涨跌幅曲线（来自 block_daily_price 日线）
  //   basis=industry（默认）：行业板块 881xxx
  //   basis=limit_up：以近 30 个交易日涨停个股所属概念板块（885/886xxx）为基准（全部纳入）
  app.get('/api/sector-rotation', asyncHandler(async (request, response) => {
    const currentYear = Number(formatDateTime().slice(0, 4));
    const year = numberParam(request.query.year, currentYear, 2000, 2100);
    const startDate = `${year}-01-01`;
    const endDate = `${year + 1}-01-01`;
    const limitUpBasis = String(request.query.basis ?? 'industry') === 'limit_up';
    const yearWindow = String(request.query.window ?? 'recent') === 'year';
    const hotSectors = limitUpBasis
      ? yearWindow
        ? await store.getLimitUpSectorsBetween(startDate, endDate, CONCEPT_BLOCK_PREFIXES)
        : await store.getRecentLimitUpSectors(RECENT_LIMIT_UP_DAYS, CONCEPT_BLOCK_PREFIXES)
      : [];
    const codes = limitUpBasis ? new Set(hotSectors.map((sector) => sector.code)) : null;
    const keep = (code: string) => (codes ? codes.has(code) : isIndustryBlockCode(code));

    let rows = await store.getBlockPriceHistory(startDate, endDate);
    rows = rows.filter((row) => keep(row.block_code));
    // 同花顺 last.js 只回最近约 140 根日线，年初数据往往缺失；对缺失年初的板块按年补采一次，
    // 结果落库后后续请求直接命中 SQLite，不再联网。
    const names = new Map(rows.map((row) => [row.block_code, row.block_name]));
    for (const sector of hotSectors) if (!names.has(sector.code)) names.set(sector.code, sector.name || sector.code);
    // 无涨停基准时，今年涨停涉及的行业板块即使还没有任何日线，也要进入补采池。
    if (!limitUpBasis) {
      for (const sector of await store.getIndustryLimitUpSectors(startDate, endDate)) {
        if (!names.has(sector.code)) names.set(sector.code, sector.name);
      }
    }
    const firstDateByBlock = new Map<string, string>();
    for (const row of rows) {
      if (!firstDateByBlock.has(row.block_code)) firstDateByBlock.set(row.block_code, row.date);
    }
    const missing = [...names.keys()].filter((code) => {
      if (backfillAttempted.has(`${year}:${code}`)) return false;
      const first = firstDateByBlock.get(code);
      return !first || first > `${year}-02-15`;
    });
    if (missing.length) {
      let cursor = 0;
      const worker = async () => {
        while (cursor < missing.length) {
          const code = missing[cursor];
          cursor += 1;
          backfillAttempted.add(`${year}:${code}`);
          const { klines } = await fetchBlockYearKlines(code, year, '01');
          if (klines.length) await store.upsertBlockPrices(code, names.get(code) ?? code, klines);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, missing.length) }, () => worker()));
      rows = (await store.getBlockPriceHistory(startDate, endDate)).filter((row) => keep(row.block_code));
    }
    response.json(buildSectorRotation(rows, year, codes ?? undefined));
  }));

  // Ranking
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
    const days = numberParam(request.query.days, 20, 5, MAX_BACKTEST_DAYS);
    const task = startRankingTask(requestedDate, days);
    response.status(202).json({ task_id: task.id, status: 'started', message: '排行计算已启动' });
  }));

  // Tasks
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

  // Benchmark
  app.get('/api/benchmark', asyncHandler(async (request, response) => {
    const dates = String(request.query.dates ?? '').split(',').filter(Boolean);
    const initialCapital = Number(request.query.initial_capital) || 100_000;
    if (!dates.length) {
      response.status(400).json({ error: '需要 dates 参数（逗号分隔的日期列表）' });
      return;
    }
    const { klines, source } = await fetchSohuIndexKlines();
    if (!klines.length) {
      response.status(502).json({ error: '基准指数数据不可用', source });
      return;
    }
    const curve = buildBenchmarkCurve(klines, dates, initialCapital);
    response.json({ curve: curve.map((p) => ({ date: p.date, total: p.value })), name: '上证380', source });
  }));

  // Backtest
  app.post('/api/backtest/collect', asyncHandler(async (request, response) => {
    const days = numberParam(request.query.days, 20, MIN_BACKTEST_DAYS, MAX_BACKTEST_DAYS);
    const requestedDate = marketDateParam(request.query.date);
    const task = tasks.start('backtest_collect', `构建近 ${days} 日历史样本`, async ({ progress, cancelled, traceId }) => {
      const ranking = await store.getRankingUniverse();
      if (!ranking.rankings.length) throw new Error('当前股票池为空，无法采集回测行情');
      const prepared = await marketService.ensureHistoricalCoverage({
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
    const mode = String(request.query.mode ?? 'random') === 'current' ? 'current' : 'random';
    const days = numberParam(request.query.days, 20, MIN_BACKTEST_DAYS, MAX_BACKTEST_DAYS);
    const strategyCount = numberParam(request.query.strategy_count, 20, 1, 200);
    const maxHoldDays = numberParam(request.query.max_hold_days, 5, 1, 60);
    const maxPositions = numberParam(request.query.max_positions, 10, 1, 20);
    const positionSizePct = numberParam(request.query.position_size_pct, 10, 1, 100);
    const takeProfitPct = numberParam(request.query.take_profit_pct, 15, 1, 60);
    const stopLossPct = numberParam(request.query.stop_loss_pct, 5, 1, 30);
    const trendWeightPct = numberParam(request.query.trend_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const volumePriceWeightPct = numberParam(request.query.volume_price_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const distanceFromLowWeightPct = numberParam(request.query.distance_from_low_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const volatilityWeightPct = numberParam(request.query.volatility_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const relativeStrengthWeightPct = numberParam(request.query.relative_strength_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const requestedDate = marketDateParam(request.query.date);
    const taskLabel = mode === 'current'
      ? `运行 ${days} 日当前方案回测`
      : `运行 ${days} 日随机组合回测（${strategyCount} 组）`;
    const task = tasks.start('backtest_run', taskLabel, async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法运行回测');
      const prepared = await marketService.ensureHistoricalCoverage({
        rankings: source.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.58, message),
      });
      if (cancelled()) return null;
      const history = prepared.history;
      console.log('[backtest] /api/backtest/run', {
        mode,
        days,
        strategy_count: strategyCount,
        max_hold_days: maxHoldDays,
        max_positions: maxPositions,
        position_size_pct: positionSizePct,
        take_profit_pct: takeProfitPct,
        stop_loss_pct: stopLossPct,
        trend_weight_pct: trendWeightPct,
        volume_price_weight_pct: volumePriceWeightPct,
        distance_from_low_weight_pct: distanceFromLowWeightPct,
        volatility_weight_pct: volatilityWeightPct,
        relative_strength_weight_pct: relativeStrengthWeightPct,
        history_as_of_date: history.as_of_date,
        stocks: history.stocks.length,
      });
      await audit.info('backtest', 'run_started', {
        traceId,
        data: {
          mode,
          days,
          strategy_count: strategyCount,
          max_hold_days: maxHoldDays,
          max_positions: maxPositions,
          position_size_pct: positionSizePct,
          take_profit_pct: takeProfitPct,
          stop_loss_pct: stopLossPct,
          trend_weight_pct: trendWeightPct,
          volume_price_weight_pct: volumePriceWeightPct,
          distance_from_low_weight_pct: distanceFromLowWeightPct,
          volatility_weight_pct: volatilityWeightPct,
          relative_strength_weight_pct: relativeStrengthWeightPct,
          history_as_of_date: history.as_of_date,
          stocks: history.stocks.length,
        },
      });
      progress(
        62,
        mode === 'current'
          ? '按当前方案参数执行回测'
          : `随机生成并回测 ${strategyCount} 组参数组合`,
      );
      const scoringConfig = readScoringConfig(request);
      const results = mode === 'current'
        ? [runPolarsBacktest(history, {
          days,
          maxHoldDays,
          maxPositions,
          positionSizePct,
          takeProfitPct,
          stopLossPct,
          trendWeightPct,
          volumePriceWeightPct,
          distanceFromLowWeightPct,
          volatilityTrendWeightPct: volatilityWeightPct,
          relativeStrengthWeightPct: relativeStrengthWeightPct,
          scoringConfig,
        })]
        : runRandomizedBacktest(history, {
          days,
          strategyCount,
          maxHoldDaysUpper: maxHoldDays,
          maxPositionsUpper: maxPositions,
          positionSizePctUpper: positionSizePct,
          takeProfitPctUpper: takeProfitPct,
          stopLossPctUpper: stopLossPct,
          trendWeightPctUpper: trendWeightPct,
          volumePriceWeightPctUpper: volumePriceWeightPct,
          distanceFromLowWeightPctUpper: distanceFromLowWeightPct,
          volatilityTrendWeightPctUpper: volatilityWeightPct,
          relativeStrengthWeightPctUpper: relativeStrengthWeightPct,
          scoringConfig,
        });
      progress(88, mode === 'current' ? '汇总含交易成本的收益、胜率与回撤' : `汇总 ${results.length} 组回测结果`);
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (mode === 'random') {
          progress(88 + (index / Math.max(results.length, 1)) * 10, `保存第 ${index + 1}/${results.length} 组回测`);
        }
        await store.saveBacktest(result);
        await audit.info('backtest', 'run_completed', {
          traceId,
          data: {
            run_id: result.run_id,
            combo_index: result.config.combo_index,
            batch_size: result.config.strategy_count,
            summary: result.summary,
            config: result.config,
            trades: result.trades,
            output_path: path.join(store.runtime, 'backtests', `${result.run_id}.json`),
          },
        });
      }
      const primary = results[0];
      return {
        run_id: primary.run_id,
        run_ids: results.map((item) => item.run_id),
        summary: primary.summary,
        collected: prepared.collected,
        message: mode === 'random'
          ? `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成 ${results.length} 组随机组合回测（${primary.date_range}）`
          : `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成 ${primary.date_range} 回测`,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '回测任务已启动' });
  }));

  app.post('/api/backtest/optimize', asyncHandler(async (request, response) => {
    const days = numberParam(request.query.days, 20, MIN_BACKTEST_DAYS, MAX_BACKTEST_DAYS);
    const simulationDays = numberParam(request.query.simulation_days, days + MIN_BACKTEST_DAYS, MIN_BACKTEST_DAYS, MAX_BACKTEST_DAYS);
    const forwardDays = simulationDays - days;
    if (forwardDays < MIN_BACKTEST_DAYS) {
      response.status(400).json({ error: `优化天数必须至少比模拟天数少 ${MIN_BACKTEST_DAYS} 日，以保留 forward 验证窗口` });
      return;
    }
    const requestedDate = marketDateParam(request.query.date);
    const taskLabel = `参数优化（模拟前 ${days} 日训练，后续 ${forwardDays} 日验证）`;
    const task = tasks.start('backtest_optimize', taskLabel, async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法运行参数优化');
      const prepared = await marketService.ensureHistoricalCoverage({
        rankings: source.rankings,
        days: simulationDays,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.55, message),
      });
      if (cancelled()) return null;
      const history = prepared.history;
      const dates = history.calendar.filter((date) => date <= history.as_of_date).sort();
      const trainingAsOfDate = dates.at(-forwardDays - 1);
      if (!trainingAsOfDate) throw new Error(`历史行情不足，无法在 ${days} 日优化样本后保留 ${forwardDays} 日 forward 验证窗口`);
      const trainingHistory = { ...history, as_of_date: trainingAsOfDate };
      console.log('[backtest] /api/backtest/optimize', {
        days,
        simulation_days: simulationDays,
        forward_days: forwardDays,
        training_as_of_date: trainingAsOfDate,
        history_as_of_date: history.as_of_date,
        stocks: history.stocks.length,
      });
      await audit.info('backtest', 'optimize_started', {
        traceId,
        data: { days, simulation_days: simulationDays, forward_days: forwardDays, training_as_of_date: trainingAsOfDate, history_as_of_date: history.as_of_date, stocks: history.stocks.length },
      });
      progress(58, '阶段1：优化 scoreStock 评分参数（距低点分档 + 趋势）');
      const result = optimizeStrategyParams(trainingHistory, { days });
      progress(90, '阶段2：固定评分配置，网格搜索回测交易参数');
      await audit.info('backtest', 'optimize_completed', {
        traceId,
        data: { days, simulation_days: simulationDays, forward_days: forwardDays, training_as_of_date: trainingAsOfDate, scoring: result.scoring, optimized: result.optimized, validation: result.validation },
      });
      // 持久化到文件，供前端随时读取
      await store.saveOptimizeResult(result);
      return {
        ...result,
        training_as_of_date: trainingAsOfDate,
        forward_days: forwardDays,
        collected: prepared.collected,
        message: `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成参数优化（训练截至 ${trainingAsOfDate}，${forwardDays} 日后进入模拟窗口）`,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '参数优化任务已启动' });
  }));

  app.get('/api/backtest/list', asyncHandler(async (_request, response) => {
    response.json(await store.listBacktests());
  }));

  app.get('/api/backtest/optimize-result', asyncHandler(async (_request, response) => {
    const result = await store.loadOptimizeResult();
    if (!result) {
      response.status(404).json({ error: 'no optimize result found' });
      return;
    }
    response.json(result);
  }));

  app.get('/api/backtest/factor-ic', asyncHandler(async (request, response) => {
    // 因子有效性面板：与回测收益正交的证据，用来判断某个维度是否真的预测未来收益，
    // 而不是让参数优化器在几十个交易日上拟合出一组「看起来最赚钱」的权重。
    const history = await store.getHistoricalMarket();
    if (!history?.stocks?.length) {
      response.status(404).json({ error: 'no historical market data; run 行情采集 first' });
      return;
    }
    const days = numberParam(request.query.days, 60, 10, 500);
    const forwardDays = numberParam(request.query.forward_days, 5, 1, 20);
    const rankingConfig = await store.getRankingConfig();
    response.json(computeFactorIC(history, days, forwardDays, rankingConfig?.scoring_config));
  }));

  // 过拟合分析：前/中/后 3 段窗口对比 + 最末窗口随机参数分布对照。
  // 跑在异步任务里，因为最末窗口要再跑 N 次回测。
  app.post('/api/backtest/overfit-analysis', asyncHandler(async (request, response) => {
    const days = numberParam(request.query.days, 60, MIN_BACKTEST_DAYS, MAX_BACKTEST_DAYS);
    const strategyCount = numberParam(request.query.strategy_count, 50, 20, 200);
    const maxHoldDays = numberParam(request.query.max_hold_days, 5, 1, 60);
    const maxPositions = numberParam(request.query.max_positions, 10, 1, 20);
    const positionSizePct = numberParam(request.query.position_size_pct, 10, 1, 100);
    const takeProfitPct = numberParam(request.query.take_profit_pct, 15, 1, 60);
    const stopLossPct = numberParam(request.query.stop_loss_pct, 5, 1, 30);
    const trendWeightPct = numberParam(request.query.trend_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const volumePriceWeightPct = numberParam(request.query.volume_price_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const distanceFromLowWeightPct = numberParam(request.query.distance_from_low_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const volatilityWeightPct = numberParam(request.query.volatility_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const relativeStrengthWeightPct = numberParam(request.query.relative_strength_weight_pct, 100, 1, MAX_FACTOR_WEIGHT_PCT);
    const requestedDate = marketDateParam(request.query.date);
    const scoringConfig = readScoringConfig(request);
    const task = tasks.start('backtest_overfit', `过拟合分析（${days} 日窗口 + ${strategyCount} 组随机参数）`, async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法运行过拟合分析');
      const prepared = await marketService.ensureHistoricalCoverage({
        rankings: source.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.5, message),
      });
      if (cancelled()) return null;
      const history = prepared.history;
      console.log('[backtest] /api/backtest/overfit-analysis', {
        days,
        strategy_count: strategyCount,
        history_as_of_date: history.as_of_date,
        stocks: history.stocks.length,
      });
      await audit.info('backtest', 'overfit_started', {
        traceId,
        data: { days, strategy_count: strategyCount, history_as_of_date: history.as_of_date, stocks: history.stocks.length },
      });
      const result = runOverfitAnalysis(history, {
        days,
        strategyCount,
        base: {
          maxHoldDays,
          maxPositions,
          positionSizePct,
          takeProfitPct,
          stopLossPct,
          trendWeightPct,
          volumePriceWeightPct,
          distanceFromLowWeightPct,
          volatilityTrendWeightPct: volatilityWeightPct,
          relativeStrengthWeightPct,
        },
        scoringConfig,
        onProgress: (stage, value, message) => {
          if (stage === 'windows') progress(50 + value * 0.2, message);
          else if (stage === 'random') progress(70 + value * 0.25, message);
          else if (stage === 'summary') progress(95, message);
        },
      });
      await audit.info('backtest', 'overfit_completed', {
        traceId,
        data: {
          days,
          strategy_count: strategyCount,
          cv: result.cv,
          cv_flag: result.cv_flag,
          current_percentile: result.current_percentile,
          verdict: result.verdict,
        },
      });
      progress(100, '过拟合分析完成');
      return {
        ...result,
        collected: prepared.collected,
        message: `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成过拟合分析（${result.windows.length} 段窗口 + ${result.random_sample_size} 组随机参数）`,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '过拟合分析任务已启动' });
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

  // Simulated trading
  app.use('/api/simulated-trading', (_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });

  app.get('/api/simulated-trading/health', (_request, response) => {
    const brokerMode = paper.getBrokerMode();
    response.json({
      ok: true,
      mode: 'simulated',
      broker_mode: brokerMode,
      source: brokerMode === 'web' ? 'tonghuashun-web' : 'tonghuashun-gui',
      account_source: brokerMode === 'web' ? 'tonghuashun-web' : 'tonghuashun-gui',
      execution_tool: brokerMode === 'web' ? 'cgiwt' : 'applescript',
      trading_core: 'nodejs',
      engine_version: PAPER_ENGINE_VERSION,
      service: 'node-polars-ths-simulated-trading',
    });
  });

  // 进入交易页面时的登录态检测（Web 通道）
  app.get('/api/simulated-trading/login-status', asyncHandler(async (_request, response) => {
    response.json(await paper.getLoginStatus());
  }));

  // 未登录时启动本机浏览器（Chrome/Edge）登录窗口，非阻塞；前端轮询 login-status
  app.post('/api/simulated-trading/login', asyncHandler(async (_request, response) => {
    const traceId = String(response.locals.traceId);
    response.json(paper.requestInteractiveLogin(traceId));
  }));

  app.get('/api/simulated-trading/bootstrap', asyncHandler(async (_request, response) => {
    const traceId = String(response.locals.traceId);
    const [analysis, ranking] = await Promise.all([store.getAnalysis(), store.getRanking()]);
    const marketAverageChange = averageRankingChange(ranking.rankings);
    const limitUpRecords = (await store.getLimitUpByDate(ranking.date))
      .map((record) => ({ date: record.date, stock_code: record.stock_code }));
    const history = await store.getHistoricalMarket();
    const calendar = await loadTradingCalendar(store);
    const clock = shanghaiClock(new Date());
    const [overview, automation] = await Promise.all([
      paper.cachedOverview(analysisWithStats(analysis), ranking.date, ranking.rankings, calendar, traceId, marketAverageChange, limitUpRecords),
      paper.getAutomation(),
    ]);
    response.json({
      overview,
      automation: automation.automation,
      trading_session: buildTradingSession(clock, calendar),
    });
  }));

  app.get('/api/simulated-trading/overview', asyncHandler(async (_request, response) => {
    const traceId = String(response.locals.traceId);
    const calendar = await loadTradingCalendar(store);
    const context = paper.isAccountSyncOnlyNow(calendar)
      ? await marketService.loadPaperContextFromStore(traceId)
      : await marketService.loadPaperContext(false, traceId);
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
    let requestedWindow = String(request.body?.window ?? 'auto');
    if (requestedWindow === 'auto') {
      const calendar = await loadTradingCalendar(store);
      const clock = shanghaiClock(new Date());
      const rejection = immediateAutoWindowRejection(clock, calendar);
      if (rejection) {
        console.log('[paper] immediate auto window rejected', { clock: clock.timestamp, reason: rejection });
        response.status(400).json({ ok: false, error: rejection });
        return;
      }
      requestedWindow = resolveAutoTradingWindow(clock);
    }
    if (!['open', 'near_close', 'close', 'post_close'].includes(requestedWindow)) {
      response.status(400).json({ ok: false, error: '交易窗口必须是 open、near_close、close 或 post_close' });
      return;
    }
    const window = requestedWindow as 'open' | 'near_close' | 'close' | 'post_close';
    const windowTaskMeta: Record<typeof window, { type: string; name: string; startedMessage: string; refreshMarket: boolean }> = {
      open: {
        type: 'paper_open_window',
        name: '开盘执行：读取账户并提交策略委托',
        startedMessage: '开盘执行任务已启动',
        refreshMarket: false,
      },
      near_close: {
        type: 'paper_near_close_window',
        name: '临收盘执行：读取账户并提交策略委托',
        startedMessage: '临收盘执行任务已启动',
        refreshMarket: false,
      },
      close: {
        type: 'paper_close_decision',
        name: '决策：刷新行情并生成交易计划',
        startedMessage: '决策任务已启动',
        refreshMarket: true,
      },
      post_close: {
        type: 'paper_post_close_window',
        name: '盘后核对：同步账户与持仓',
        startedMessage: '盘后核对任务已启动',
        refreshMarket: false,
      },
    };
    const meta = windowTaskMeta[window];
    const task = tasks.start(meta.type, meta.name, async ({ progress, cancelled, traceId }) => {
      try {
        progress(5, meta.refreshMarket ? '准备收盘行情与策略上下文' : '准备策略上下文');
        const context = meta.refreshMarket
          ? await marketService.loadPaperContext(true, traceId, { enforceCloseTime: false })
          : await marketService.loadPaperContext(false, traceId);
        if (cancelled()) return null;
        progress(meta.refreshMarket ? 82 : 35, meta.refreshMarket ? '行情与排行已准备，正在生成下一交易日计划' : '正在执行交易窗口');
        const result = await paper.runWindowConfirmed(window, context, traceId);
        progress(98, result.message);
        return result;
      } catch (error) {
        await audit.error('paper_trading', 'manual_window_failed', {
          traceId,
          data: { window },
          error,
        });
        throw error;
      }
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: meta.startedMessage });
  }));

  app.post('/api/simulated-trading/execute', asyncHandler(async (request, response) => {
    try {
      const traceId = String(response.locals.traceId);
      response.json(await paper.execute(await marketService.loadPaperContext(false, traceId), traceId));
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

  app.post('/api/simulated-trading/strategy/apply-backtest', asyncHandler(async (request, response) => {
    const runId = String(request.body?.run_id ?? '').trim();
    if (!runId) {
      response.status(400).json({ ok: false, error: 'run_id 不能为空' });
      return;
    }
    const backtest = await store.getBacktest(runId);
    if (!backtest) {
      response.status(404).json({ ok: false, error: '回测记录不存在', run_id: runId });
      return;
    }
    const task = tasks.start('strategy_apply_backtest', `应用回测策略 ${runId}`, async ({ progress, traceId }) => {
      try {
        progress(5, '正在应用回测策略参数');
        const applied = await paper.applyBacktestStrategy(runId, backtest.config, traceId);
        const rankingConfig = rankingConfigFromBacktest(runId, backtest.config);
        await store.saveRankingConfig(rankingConfig);
        console.log('[paper] saved ranking config from backtest', {
          run_id: runId,
          factor_weights: rankingConfig.factor_weights,
          has_custom_scoring: Boolean(backtest.config.scoring_config_json),
        });

        const source = await store.getRankingUniverse();
        const rankingTask = source.rankings.length
          ? startRankingTask(
            source.date,
            20,
            `应用回测策略后重算排行 ${runId}`,
            rankingConfig,
          )
          : null;
        const message = rankingTask
          ? '策略已应用，排行重算已转入后台'
          : '策略已应用，股票池为空，排行参数已保存但未重算';
        progress(100, message);
        return {
          ...applied,
          ranking: rankingConfig.factor_weights,
          ranking_task_id: rankingTask?.id ?? null,
          ranking_started: Boolean(rankingTask),
          ranking_recomputed: false,
          ranking_message: message,
          message,
        };
      } catch (error) {
        await audit.error('paper_trading', 'apply_backtest_strategy_failed', {
          traceId,
          data: { run_id: runId },
          error,
        });
        throw error;
      }
    });
    response.status(202).json({
      task_id: task.id,
      status: 'started',
      run_id: runId,
      message: '回测策略应用任务已启动，排行将在策略应用后后台重算',
    });
  }));

  // Mining（P4 挖掘流水线 + P5 下发与验证）
  app.use('/api/mining', (_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });

  // 挖掘产物落在数据目录下（server/data/mining），与运行期状态分离。
  // 部分测试用替身 store 注册路由，没有 root 时退回默认数据目录。
  const miningRoot = path.join(store.root ?? path.join(MODULE_DIR, 'data'), 'mining');
  const miningStore = new MiningStore(miningRoot);
  const instanceStore = new MiningInstanceStore(miningRoot);

  app.get('/api/mining/runs', asyncHandler(async (_request, response) => {
    const runs = await miningStore.listRuns();
    response.json({
      total: runs.length,
      runs: await Promise.all(runs.map(async (run) => ({
        run_id: run.runId,
        created_at: run.createdAt,
        code_version: run.codeVersion,
        data_version: run.dataVersion,
        status: run.status,
        error: run.error,
        strategies: run.strategies,
        universe_size: run.universe.length,
        candidate_count: (await miningStore.getResults(run.runId)).length,
      }))),
    });
  }));

  app.get('/api/mining/runs/:runId', asyncHandler(async (request, response) => {
    const runId = String(request.params.runId);
    const run = await miningStore.getRun(runId);
    if (!run) {
      response.status(404).json({ error: '挖掘批次不存在', run_id: runId });
      return;
    }
    response.json({
      run,
      results: await miningStore.getResults(runId),
      report: await miningStore.getReport(runId),
    });
  }));

  app.get('/api/mining/runs/:runId/report.html', asyncHandler(async (request, response) => {
    const runId = String(request.params.runId);
    const html = await miningStore.getReportHtml(runId);
    if (!html) {
      response.status(404).json({ error: '报告不存在', run_id: runId });
      return;
    }
    response.type('html').send(html);
  }));

  app.post('/api/mining/runs/:runId/replay', asyncHandler(async (request, response) => {
    const runId = String(request.params.runId);
    const traceId = String(response.locals.traceId);
    const run = await miningStore.getRun(runId);
    if (!run) {
      response.status(404).json({ error: '挖掘批次不存在', run_id: runId });
      return;
    }
    const days = Number((request.body as { days?: number } | undefined)?.days ?? run.config.days ?? 250);
    const task = tasks.start('mining_replay', `复现挖掘批次 ${runId}`, async ({ progress, traceId: taskTraceId }) => {
      const universeSource = await store.getRankingUniverse();
      progress(10, '准备历史行情快照');
      const outcome = await replayMiningRun(runId, {
        store: miningStore,
        prepareData: async () => {
          const prepared = await marketService.ensureHistoricalCoverage({
            rankings: universeSource.rankings,
            days,
            asOfDate: universeSource.date,
            traceId: taskTraceId,
          });
          return prepared.history;
        },
      });
      progress(100, outcome.message);
      return outcome;
    });
    response.status(202).json({ task_id: task.id, status: 'started', trace_id: traceId });
  }));

  app.get('/api/mining/calibration', asyncHandler(async (_request, response) => {
    const calibrations = await miningStore.listCalibrations();
    response.json({
      total: calibrations.length,
      calibrations,
      latest: calibrations[0] ?? null,
    });
  }));

  app.post('/api/mining/deploy', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Partial<MiningDeployRequest> & Record<string, unknown>;
    const runId = String(body.runId ?? body.run_id ?? '').trim();
    const operator = String(body.operator ?? '').trim();
    const confirmation = String(body.confirmation ?? '').trim();
    const rank = Number(body.rank);
    if (!runId) {
      response.status(400).json({ error: 'run_id 不能为空' });
      return;
    }
    if (!operator) {
      response.status(400).json({ error: '下发必须记录操作人' });
      return;
    }
    if (!confirmation) {
      response.status(400).json({ error: '下发需显式确认：请把 runId 原样填入 confirmation' });
      return;
    }
    if (!Number.isFinite(rank)) {
      response.status(400).json({ error: 'rank 必须是数字' });
      return;
    }
    const run = await miningStore.getRun(runId);
    if (!run) {
      response.status(404).json({ error: '挖掘批次不存在', run_id: runId });
      return;
    }
    const results = await miningStore.getResults(runId);
    const result = results.find((item) => item.rank === rank);
    if (!result) {
      response.status(404).json({ error: '该批次没有对应排名的候选参数', run_id: runId, rank });
      return;
    }
    let config;
    try {
      config = buildInstanceConfig(
        {
          runId,
          rank,
          operator,
          confirmation,
          universe: body.universe as string[] | undefined,
          capitalLimit: (body.capitalLimit ?? body.capital_limit) as number | undefined,
          strategyIds: (body.strategyIds ?? body.strategy_ids) as string[] | undefined,
        },
        run,
        result,
      );
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    await instanceStore.save(config);
    await audit.info('mining', 'candidate_deployed', {
      traceId: String(response.locals.traceId),
      data: {
        run_id: config.sourceRunId,
        rank: config.sourceRank,
        instance_id: config.instanceId,
        operator: config.operator,
        channel: config.channel,
        params: config.params,
      },
    });
    response.status(201).json({ ok: true, instance: config });
  }));

  app.get('/api/mining/instances', asyncHandler(async (_request, response) => {
    const instances = await instanceStore.list();
    response.json({ total: instances.length, instances });
  }));

  app.get('/api/mining/instances/:instanceId', asyncHandler(async (request, response) => {
    const instanceId = String(request.params.instanceId);
    const config = await instanceStore.get(instanceId);
    if (!config) {
      response.status(404).json({ error: '实例不存在', instance_id: instanceId });
      return;
    }
    const state = await readInstanceState(miningStore.root, instanceId);
    response.json({ instance: config, state });
  }));

  app.get('/api/mining/instances/:instanceId/validation', asyncHandler(async (request, response) => {
    const instanceId = String(request.params.instanceId);
    const config = await instanceStore.get(instanceId);
    if (!config) {
      response.status(404).json({ error: '实例不存在', instance_id: instanceId });
      return;
    }
    const results = await miningStore.getResults(config.sourceRunId);
    const result = results.find((item) => item.rank === config.sourceRank);
    if (!result) {
      response.status(404).json({ error: '找不到该实例对应的挖掘结果', run_id: config.sourceRunId });
      return;
    }
    const state = await readInstanceState(miningStore.root, instanceId);
    const instructions = state?.instructions ?? [];
    const friction = computeFrictionStats(instructions);
    const tradingDays = new Set(instructions.map((instruction) => instruction.signal_date)).size;
    const report = buildValidationReport({
      config,
      predicted: result.outOfSample,
      predictedOutOfSampleDays: result.outOfSampleDays,
      actual: computeActualMetrics(instructions, tradingDays),
      actualTradingDays: tradingDays,
      friction,
    });
    response.json(report);
  }));

  // Audit
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
}
