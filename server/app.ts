import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AnalysisData, BlockAnalysis, LimitUpStock } from '../src/types.js';
import { AuditLogger, guardDetachedPromise, type AuditLevel } from './audit-log.js';
import { historicalStrategyCandidates, runPolarsBacktest } from './backtest-engine.js';
import { DataStore } from './data-store.js';
import { compactDate, formatDateTime, round, sleep } from './format.js';
import {
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
import { queryRankings, recomputeRanking, refreshAnalysis } from './polars-engine.js';
import { analyzeBlockTrend, blockStrategy, klinesToBars } from './scoring-engine.js';
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

function analysisWithStats(data: AnalysisData): AnalysisData {
  const enriched = refreshAnalysis(data);
  return { ...enriched, timestamp: data.timestamp };
}

function flattenLimitUp(data: AnalysisData, date: string) {
  const seen = new Set<string>();
  return data.blocks.flatMap((block) => block.stock_list.map((stock) => ({
    date,
    stock_code: stock.code,
    stock_name: stock.name,
    sector_code: block.code,
    sector_name: block.name,
    continue_num: stock.continue_num ?? 1,
    reason_type: stock.reason_type ?? '',
    sector_change: block.block_info.change,
    latest: stock.latest ?? null,
    change_rate: stock.change_rate ?? null,
  }))).filter((item) => {
    const key = `${item.stock_code}:${item.sector_code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
): Promise<{ analysis: AnalysisData; blocks: number; source: 'ths-limit-up' | 'none' }> {
  const { blocks: tops, source } = await fetchBlockTop(date);
  if (!tops.length) return { analysis: base, blocks: 0, source };
  const results: BlockAnalysis[] = [];
  let cursor = 0;
  let done = 0;
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
      results.push(buildBlockAnalysis(block, daily.klines, weekly.klines, monthly.klines));
      done += 1;
      options.progress?.(done / tops.length * 100, `板块趋势分类 ${done}/${tops.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tops.length) }, () => worker()));
  results.sort((left, right) => right.block_info.limit_up_num - left.block_info.limit_up_num);
  const analysis: AnalysisData = { ...base, timestamp: formatDateTime(), blocks: results };
  return { analysis: refreshAnalysis(analysis), blocks: results.length, source };
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
  const loadPaperContext = async (refreshForClose = false, traceId: string = randomUUID()) => {
    const [analysis, ranking, storedHistory] = await Promise.all([
      store.getAnalysis(),
      store.getRanking(),
      store.getHistoricalMarket(),
    ]);
    let history = storedHistory;
    let strategyRankings = ranking.rankings;
    let strategyDate = ranking.date;
    let marketAverageChange = averageRankingChange(ranking.rankings);
    if (refreshForClose) {
      const now = formatDateTime();
      const hourMinute = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16));
      if (hourMinute < 15 * 60) throw new Error('收盘决策只能在交易日 15:00 后运行');
      const today = compactDate().slice(0, 8);
      if (!history || history.as_of_date !== today) {
        history = await collectHistoricalMarketData(ranking.rankings, {
          days: 20,
          asOfDate: today,
          audit,
          traceId,
        });
        if (!history) throw new Error('收盘历史行情准备失败');
        await store.saveHistoricalMarket(history);
        await audit.info('market_data', 'snapshot_saved', {
          traceId,
          data: {
            path: path.join(store.runtime, 'historical-market.json'),
            as_of_date: history.as_of_date,
            stocks: history.stocks.length,
            failed_stocks: history.failed_stocks,
          },
        });
      } else {
        await audit.info('market_data', 'snapshot_cache_hit', {
          traceId,
          data: { as_of_date: history.as_of_date, stocks: history.stocks.length, generated_at: history.generated_at },
        });
      }
      strategyDate = history.as_of_date;
      strategyRankings = historicalStrategyCandidates(history, strategyDate);
      marketAverageChange = averageHistoricalChange(history, strategyDate);
      await audit.info('factor_ranking', 'historical_ranking_completed', {
        traceId,
        data: {
          ranking_date: strategyDate,
          candidates: strategyRankings,
          source_stocks: history.stocks.length,
          engine: 'shared-backtest-score',
        },
      });
    }
    return {
      analysis: analysisWithStats(analysis),
      rankingDate: strategyDate,
      rankings: strategyRankings,
      calendar: history?.calendar ?? [],
      marketAverageChange,
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
      stack: ['React', 'Tailwind CSS', 'Express', 'nodejs-polars'],
      timestamp: formatDateTime(),
    });
  });

  app.get('/api/analysis', asyncHandler(async (request, response) => {
    if (String(request.query.refresh ?? '0') === '1') {
      const task = tasks.start('analysis_fetch', '刷新指数与板块分析', async ({ progress, cancelled, traceId }) => {
        progress(12, '读取行情快照');
        await sleep(120);
        if (cancelled()) return null;
        const current = await store.getAnalysis();
        progress(48, 'Polars 聚合板块热度');
        await sleep(160);
        if (cancelled()) return null;
        const refreshed = refreshAnalysis(current);
        await audit.info('market_analysis', 'analysis_refreshed', {
          traceId,
          data: { source_timestamp: current.timestamp, result: refreshed },
        });
        progress(82, '重算市场宽度指标');
        await store.saveAnalysis(refreshed);
        await sleep(100);
        return refreshed;
      });
      response.status(202).json({ task_id: task.id, status: 'started', message: '分析任务已启动' });
      return;
    }
    response.json(analysisWithStats(await store.getAnalysis()));
  }));

  app.post('/api/analysis/collect', asyncHandler(async (request, response) => {
    const requestedDate = String(request.query.date ?? '').trim();
    const date = /^\d{8}$/.test(requestedDate.replaceAll('-', '')) ? requestedDate.replaceAll('-', '') : compactDate().slice(0, 8);
    const task = tasks.start('analysis_collect', '采集涨停板块并分类趋势', async ({ progress, cancelled, traceId }) => {
      progress(6, '拉取同花顺涨停板块排行');
      const base = await store.getAnalysis();
      if (cancelled()) return null;
      const collected = await collectLimitUpAnalysis(base, date, {
        cancelled,
        progress: (pct, message) => progress(10 + pct * 0.8, message),
      });
      if (cancelled()) return null;
      if (!collected.blocks) {
        await audit.warn('market_analysis', 'limit_up_collection_empty', {
          traceId,
          data: { date, source: collected.source },
        });
        throw new Error('同花顺涨停板块数据不可用（可能被反爬拦截），已保留现有分析快照');
      }
      progress(92, '重算市场情绪与宽度');
      await store.saveAnalysis(collected.analysis);
      await audit.info('market_analysis', 'limit_up_collected', {
        traceId,
        data: {
          date,
          blocks: collected.blocks,
          source: collected.source,
          total_limit_up: collected.analysis.sentiment.total_limit_up,
          sentiment: collected.analysis.sentiment.sentiment,
        },
      });
      return {
        date,
        blocks: collected.blocks,
        source: collected.source,
        sentiment: collected.analysis.sentiment.sentiment,
        total_limit_up: collected.analysis.sentiment.total_limit_up,
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '涨停采集任务已启动' });
  }));

  app.get('/api/limit_up', asyncHandler(async (request, response) => {
    const analysis = await store.getAnalysis();
    const date = String(request.query.date || analysis.timestamp.slice(0, 10).replaceAll('-', ''));
    response.json(flattenLimitUp(analysis, date));
  }));

  app.get('/api/klines', asyncHandler(async (request, response) => {
    const symbol = String(request.query.symbol ?? '').trim().toLowerCase();
    if (!/^(sh|sz)\d{6}$/.test(symbol)) {
      response.status(400).json({ error: 'symbol 必须是 sh/sz 加 6 位代码' });
      return;
    }
    const limit = numberParam(request.query.limit, 120, 1, 1000);
    const marketData = await fetchAdjustedKlines(symbol, limit);
    response.setHeader('x-market-data-source', marketData.source);
    response.json({ symbol, klines: marketData.klines, count: marketData.klines.length, source: marketData.source });
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
    response.setHeader('x-market-data-source', marketData.source);
    response.json(priceRows(marketData.klines));
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
    response.setHeader('x-market-data-source', marketData.source);
    response.json(priceRows(marketData.klines));
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

  app.post('/api/ranking/compute', asyncHandler(async (_request, response) => {
    const task = tasks.start('ranking_compute', '计算多因子排行榜', async ({ progress, cancelled, traceId }) => {
      progress(10, '载入 1,800+ 股票因子');
      await sleep(120);
      if (cancelled()) return null;
      const source = await store.getRanking();
      await audit.info('factor_ranking', 'ranking_started', {
        traceId,
        data: { source_date: source.date, source_timestamp: source.timestamp, rows: source.rankings.length },
      });
      progress(42, 'Polars 重算趋势、价量与位置得分');
      const computed = recomputeRanking(source);
      await sleep(220);
      if (cancelled()) return null;
      progress(78, '生成策略分层与全市场排名');
      await store.saveRanking(computed);
      await audit.info('factor_ranking', 'ranking_completed', {
        traceId,
        data: {
          ranking_date: computed.date,
          total_stocks: computed.total_stocks,
          top_rankings: computed.rankings.slice(0, 50),
          output_path: path.join(store.runtime, 'ranking.json'),
        },
      });
      await sleep(120);
      return { date: computed.date, total_stocks: computed.total_stocks };
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
    const task = tasks.start('backtest_collect', `构建近 ${days} 日历史样本`, async ({ progress, cancelled, traceId }) => {
      const ranking = await store.getRanking();
      progress(3, '连接真实历史行情源');
      const history = await collectHistoricalMarketData(ranking.rankings, {
        days,
        asOfDate: ranking.date,
        cancelled,
        audit,
        traceId,
        progress: (completed, total, message) => progress(5 + completed / total * 88, message),
      });
      if (!history || cancelled()) return null;
      progress(95, '保存无未来数据的历史样本');
      await store.saveHistoricalMarket(history);
      await audit.info('market_data', 'snapshot_saved', {
        traceId,
        data: { path: path.join(store.runtime, 'historical-market.json'), as_of_date: history.as_of_date, stocks: history.stocks.length },
      });
      return {
        days,
        stocks: history.stocks.length,
        failed_stocks: history.failed_stocks,
        as_of_date: history.as_of_date,
        source: history.source,
        status: 'ready',
      };
    });
    response.status(202).json({ task_id: task.id, status: 'started', message: '采集任务已启动' });
  }));

  app.post('/api/backtest/run', asyncHandler(async (request, response) => {
    const days = numberParam(request.query.days, 20, 5, 60);
    const maxHoldDays = numberParam(request.query.max_hold_days, 5, 1, 60);
    const task = tasks.start('backtest_run', `运行 ${days} 日策略回测`, async ({ progress, cancelled, traceId }) => {
      const source = await store.getRanking();
      let history: HistoricalMarketData | null = await store.getHistoricalMarket();
      const sourceDate = source.date.replaceAll('-', '').slice(0, 8);
      const cacheUsable = history
        && history.schema_version === 1
        && history.universe_as_of_date === sourceDate
        && history.requested_days >= days
        && history.calendar.length >= days + 1;
      if (!cacheUsable) {
        progress(3, '历史样本缺失，开始采集真实日线');
        history = await collectHistoricalMarketData(source.rankings, {
          days,
          asOfDate: source.date,
          cancelled,
          audit,
          traceId,
          progress: (completed, total, message) => progress(5 + completed / total * 52, message),
        });
        if (!history || cancelled()) return null;
        await store.saveHistoricalMarket(history);
      } else {
        progress(18, '载入已缓存的真实历史日线');
      }
      if (cancelled()) return null;
      if (!history) throw new Error('历史行情准备失败');
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
      return { run_id: result.run_id, summary: result.summary };
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
    const [overview, automation] = await Promise.all([
      paper.cachedOverview(analysisWithStats(analysis), ranking.date, ranking.rankings, [], traceId, marketAverageChange),
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
    if (request.body?.confirmation !== 'SIMULATED') {
      response.status(400).json({ ok: false, error: '请输入 SIMULATED 确认手动触发同花顺模拟窗口' });
      return;
    }
    const requestedWindow = String(request.body?.window ?? 'open');
    if (!['open', 'near_close', 'close', 'post_close'].includes(requestedWindow)) {
      response.status(400).json({ ok: false, error: '交易窗口必须是 open、near_close、close 或 post_close' });
      return;
    }
    try {
      response.json(await paper.runWindowConfirmed(
        'SIMULATED',
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
    const confirmation = String(request.body?.confirmation ?? '');
    if (confirmation !== 'SIMULATED') {
      response.status(400).json({ ok: false, error: '请输入 SIMULATED 确认只执行同花顺模拟交易' });
      return;
    }
    try {
      const traceId = String(response.locals.traceId);
      response.json(await paper.execute(confirmation, await loadPaperContext(false, traceId), traceId));
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
