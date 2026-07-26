import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AnalysisData } from '../../src/types.js';
import { guardDetachedPromise, type AuditLevel, type AuditLoggerLike } from '../audit-log.js';
import { runPolarsBacktest, runRandomizedBacktest, sectorTrendLookupMap } from '../backtest-engine.js';
import { optimizeStrategyParams } from '../backtest-param-optimizer.js';
import { fetchSohuIndexKlines, buildBenchmarkCurve } from '../benchmark.js';
import { compactDate, formatDateTime, round } from '../format.js';
import { fetchAdjustedKlines, fetchBlockKlines, MAX_BACKTEST_DAYS, MIN_BACKTEST_DAYS, type BlockKlinePeriod } from '../historical-market.js';
import { queryRankings } from '../polars-engine.js';
import { normalizeScoreStockConfig } from '../scoring-engine.js';
import type { TaskRegistry } from '../tasks.js';
import { ThsSimulatedBrokerError } from '../ths-simulated-broker.js';
import { MarketService, analysisWithStats, priceRows, averageRankingChange } from './market-service.js';
import { resolveLatestTradingDate } from '../index-bootstrap.js';
import { PAPER_ENGINE_VERSION, type PaperTradingService } from '../paper-trading.js';
import { shanghaiClock } from '../paper-trading/helpers.js';

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
    const days = numberParam(request.query.days, 20, 5, 60);
    const task = tasks.start('ranking_compute', '计算多因子排行榜', async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法获取个股行情并计算排行');
      await audit.info('factor_ranking', 'ranking_started', {
        traceId,
        data: { requested_date: requestedDate, source_date: source.date, source_timestamp: source.timestamp, rows: source.rankings.length },
      });
      const prepared = await marketService.ensureHistoricalCoverage({
        rankings: source.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.72, message),
      });
      if (cancelled()) return null;
      progress(76, `按 ${prepared.history.as_of_date} 行情计算截面因子`);
      const sectorTrendsByCode = await marketService.enrichSectorTrends(
          sectorTrendLookupMap(await store.getSectorTrendsForDate(prepared.history.as_of_date)),
          source.rankings,
          prepared.history.as_of_date,
        );
        const rankings = historicalCrossSectionRankings(
        prepared.history,
        prepared.history.as_of_date,
        source.rankings,
        sectorTrendsByCode,
      );
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
    const trendWeightPct = numberParam(request.query.trend_weight_pct, 100, 1, 100);
    const volumePriceWeightPct = numberParam(request.query.volume_price_weight_pct, 100, 1, 100);
    const distanceFromLowWeightPct = numberParam(request.query.distance_from_low_weight_pct, 100, 1, 100);
    const volatilityWeightPct = numberParam(request.query.volatility_weight_pct, 100, 1, 100);
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
    const requestedDate = marketDateParam(request.query.date);
    const taskLabel = `参数优化（近 ${days} 日距60日低点表现）`;
    const task = tasks.start('backtest_optimize', taskLabel, async ({ progress, cancelled, traceId }) => {
      const source = await store.getRankingUniverse();
      if (!source.rankings.length) throw new Error('当前股票池为空，无法运行参数优化');
      const prepared = await marketService.ensureHistoricalCoverage({
        rankings: source.rankings,
        days,
        asOfDate: requestedDate,
        traceId,
        cancelled,
        progress: (value, message) => progress(value * 0.55, message),
      });
      if (cancelled()) return null;
      const history = prepared.history;
      console.log('[backtest] /api/backtest/optimize', {
        days,
        history_as_of_date: history.as_of_date,
        stocks: history.stocks.length,
      });
      await audit.info('backtest', 'optimize_started', {
        traceId,
        data: { days, history_as_of_date: history.as_of_date, stocks: history.stocks.length },
      });
      progress(58, '阶段1：优化 scoreStock 评分参数（距低点分档 + 趋势）');
      const result = optimizeStrategyParams(history, { days });
      progress(90, '阶段2：固定评分配置，网格搜索回测交易参数');
      await audit.info('backtest', 'optimize_completed', {
        traceId,
        data: { days, scoring: result.scoring, optimized: result.optimized, validation: result.validation },
      });
      // 持久化到文件，供前端随时读取
      await store.saveOptimizeResult(result);
      return {
        ...result,
        collected: prepared.collected,
        message: `${prepared.collected ? '已补采行情并' : '行情覆盖已满足，'}完成参数优化（${history.as_of_date} 前 ${days} 日）`,
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
    const history = await store.getHistoricalMarket();
    const calendar = history?.calendar ?? [];
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
      const clock = shanghaiClock(new Date());
      const m = clock.minute;
      if (m < 9 * 60 + 25) {
        response.status(400).json({ ok: false, error: '当前不在交易时段（09:25 后方可执行）' });
        return;
      } else if (m < 10 * 60) {
        requestedWindow = 'open';
      } else if (m < 14 * 60 + 50) {
        requestedWindow = 'open';
      } else if (m < 15 * 60) {
        requestedWindow = 'near_close';
      } else if (m < 15 * 60 + 5) {
        requestedWindow = 'close';
      } else {
        requestedWindow = 'post_close';
      }
    }
    if (!['open', 'near_close', 'close', 'post_close'].includes(requestedWindow)) {
      response.status(400).json({ ok: false, error: '交易窗口必须是 open、near_close、close 或 post_close' });
      return;
    }
    try {
      response.json(await paper.runWindowConfirmed(
        requestedWindow as 'open' | 'near_close' | 'close' | 'post_close',
        await marketService.loadPaperContext(requestedWindow === 'close', String(response.locals.traceId)),
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