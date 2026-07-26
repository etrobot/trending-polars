import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { DataStore } from '../server/data-store.js';
import { PaperTradingService } from '../server/paper-trading.js';
import { TaskRegistry } from '../server/tasks.js';
import type { SimulatedAccountSnapshot, SimulatedBroker } from '../server/ths-simulated-broker.js';
import type { AnalysisData, BacktestResult, PaperOrder, RankingRow } from '../src/types.js';
import { historicalFixture } from './historical-fixture.js';

let root = '';
let http: ReturnType<typeof request>;
let simulatedBroker: FakeSimulatedBroker;
let store: DataStore;

class FakeSimulatedBroker implements SimulatedBroker {
  snapshotCalls = 0;
  private account: SimulatedAccountSnapshot = {
    availableCash: 100_000,
    totalAssets: 100_000,
    positions: [],
    orders: [],
  };

  async snapshot(): Promise<SimulatedAccountSnapshot> {
    this.snapshotCalls += 1;
    return {
      availableCash: this.account.availableCash,
      totalAssets: this.account.totalAssets,
      positions: this.account.positions.map((position) => ({ ...position })),
      orders: this.account.orders.map((order) => ({ ...order })),
    };
  }

  async snapshotAccountOnly(): Promise<SimulatedAccountSnapshot> {
    this.snapshotCalls += 1;
    return {
      availableCash: this.account.availableCash,
      totalAssets: this.account.totalAssets,
      positions: this.account.positions.map((position) => ({ ...position })),
      orders: [],
    };
  }

  async quote(): Promise<number> {
    return 10;
  }

  async placeOrder(order: PaperOrder) {
    this.account.availableCash -= order.amount;
    this.account.positions.push({
      stock_code: order.stock_code,
      stock_name: order.stock_name,
      shares: order.quantity,
      available_shares: 0,
      cost_price: order.price,
      current_price: order.price,
      market_value: order.amount,
      pnl_amount: 0,
      pnl_pct: 0,
    });
    this.account.orders.unshift({ ...order, status: '全部成交', cancelable: false });
    return { verified: true, brokerOutput: `ORDER_VERIFIED|${order.stock_code}` };
  }

  async cancelOrder(_side: 'buy' | 'sell', stockCode: string) {
    return { verified: true, brokerOutput: `CANCEL_VERIFIED|${stockCode}` };
  }
}

async function waitForTaskFrom(client: ReturnType<typeof request>, taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await client.get(`/api/tasks/${taskId}`);
    if (['completed', 'failed', 'cancelled'].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${taskId} did not finish`);
}

async function waitForTask(taskId: string) {
  return waitForTaskFrom(http, taskId);
}

function apiAnalysisFixture(): AnalysisData {
  return {
    timestamp: '2026-07-22 15:00:00',
    indices: [],
    sentiment: { total_blocks: 12, total_limit_up: 12, sentiment: 'cold' },
    blocks: Array.from({ length: 12 }, (_, index) => ({
      code: String(880000 + index),
      name: `测试板块${index + 1}`,
      block_info: { limit_up_num: 1, change: index / 10, max_continue: 1 },
      trend: { state_id: 1, state_name: '主线主升', trend: '上升趋势' },
      strategy: { action: 'accumulate' as const, label: '趋势跟踪', position: '5-7成' },
      stock_list: [{
        code: String(600001 + index).padStart(6, '0'),
        name: `测试股票${index + 1}`,
        continue_num: 1,
        reason_type: 'block_top 测试记录',
      }],
    })),
  };
}

function apiRankingFixture(): RankingRow[] {
  const identities = [
    ['600001', '历史样本甲'],
    ['000002', '历史样本乙'],
    ['300003', '历史样本丙'],
    ['600004', '历史样本丁'],
    ['000779', '甘咨询'],
    ['600006', '测试股票六'],
    ['600007', '测试股票七'],
    ['600008', '测试股票八'],
    ['600009', '测试股票九'],
    ['600010', '测试股票十'],
  ];
  return identities.map(([stock_code, stock_name], index) => ({
    rank: index + 1,
    stock_code,
    stock_name,
    total_score: 80 - index,
    trend_score: 35 - index / 2,
    volume_price_score: 20,
    volatility_trend_score: 8,
    alignment: 'bullish',
    strategy_action: 'accumulate',
    strategy_label: '趋势跟踪',
    strategy_position: '0.6',
    strategy_position_ratio: 0.6,
    latest_price: 10 + index,
    latest_change_rate: 1,
    sector_code: '880000',
    sector_name: '测试板块1',
    sector_trend_state_id: 1,
  }));
}

function archivedBacktestFixture(): BacktestResult {
  return {
    run_id: '20260718_235624',
    timestamp: '2026-07-18 23:56:24',
    date_range: '20260701 → 20260718',
    max_hold_days: 5,
    summary: {
      initial_capital: 100_000,
      final_capital: 100_000,
      total_return: 0,
      total_return_pct: 0,
      total_trades: 0,
      buy_count: 0,
      sell_count: 0,
      win_count: 0,
      win_rate: 0,
      expire_count: 0,
      max_holdings: 0,
    },
    config: {},
    trades: [],
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'trending-polars-test-'));
  store = new DataStore(root);
  await store.saveAnalysis(apiAnalysisFixture(), '20260722');
  await store.saveRanking({
    timestamp: '2026-07-22 15:05:00',
    date: '20260722',
    total_stocks: 10,
    rankings: apiRankingFixture(),
  });
  await store.saveHistoricalMarket(historicalFixture());
  await store.saveBacktest(archivedBacktestFixture());
  simulatedBroker = new FakeSimulatedBroker();
  const built = createApp({
    store,
    tasks: new TaskRegistry(),
    paper: new PaperTradingService(simulatedBroker, {
      now: () => new Date('2026-07-24T09:31:00+08:00'),
    }),
  });
  http = request(built.app);
});

afterAll(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe('Trending Polars API', () => {
  it('exposes health and enriched analysis data', async () => {
    const health = await http.get('/api/health').expect(200);
    expect(health.body.stack).toContain('nodejs-polars');
    expect(health.body.storage).toMatchObject({
      journal_mode: 'wal',
      foreign_keys: true,
      busy_timeout_ms: 5000,
      synchronous: 'normal',
      schema_version: 18,
      tables: expect.arrayContaining(['limit_up_record', 'stock_daily_price', 'ranking_factor']),
    });
    const analysis = await http.get('/api/analysis').expect(200);
    expect(analysis.body.blocks.length).toBeGreaterThan(10);
    expect(analysis.body.stats).toMatchObject({ valid_blocks: expect.any(Number) });
  });

  it('filters and sorts rankings through the Polars engine', async () => {
    const response = await http.get('/api/ranking?search=%E7%94%98%E5%92%A8%E8%AF%A2&page_size=10').expect(200);
    expect(response.body.total).toBeGreaterThan(0);
    expect(response.body.rankings[0].stock_name).toContain('甘咨询');
    expect(response.body.summary.top_score).toBeGreaterThan(0);
  });

  it('runs a background ranking task and persists the result', async () => {
    const started = await http.post('/api/ranking/compute?date=20260722').expect(202);
    const task = await waitForTask(started.body.task_id);
    expect(task.status).toBe('completed');
    const ranking = await http.get('/api/ranking?page_size=5').expect(200);
    expect(ranking.body.rankings.length).toBeGreaterThanOrEqual(2);
  });

  it('uses the latest trading day when refreshing analysis without an explicit date', async () => {
    const calls: string[] = [];
    const priceRows = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 3, 25 + index)).toISOString().slice(0, 10);
      const close = 10 + index * 0.1;
      return [date, String(close - 0.05), String(close), String(close + 0.1), String(close - 0.1), '1000'];
    });
    const blockRows = priceRows.slice(-30).map((row) => (
      `${String(row[0]).replaceAll('-', '')},${row[1]},${row[3]},${row[4]},${row[2]},1000,2000,,,,0`
    )).join(';');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/dataapi/limit_up/block_top')) {
        return new Response(JSON.stringify({
          data: [{
            code: '885531',
            name: '光伏概念',
            change: 1.2,
            limit_up_num: 1,
            continuous_plate_num: 1,
            stock_list: [{ code: '600088', name: '测试沪股', continue_num: 1, reason_type: '测试' }],
          }],
        }), { status: 200 });
      }
      if (url.includes('d.10jqka.com.cn/v4/line/bk_885531/')) {
        return new Response(`callback({"name":"光伏概念","data":"${blockRows}"})`, { status: 200 });
      }
      if (url.includes('web.ifzq.gtimg.cn')) {
        const symbol = new URL(url).searchParams.get('param')?.split(',')[0] ?? '';
        return new Response(`kline_dayqfq=${JSON.stringify({ code: 0, data: { [symbol]: { qfqday: priceRows } } })}`, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    try {
      const started = await http.get('/api/analysis?refresh=1').expect(202);
      const task = await waitForTask(started.body.task_id);
      expect(task.status).toBe('completed');
      expect(calls.some((url) => url.includes('/dataapi/limit_up/block_top') && url.includes('date=20260722'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refreshes analysis through blocktop, block K lines, stock quotes and index quotes', async () => {
    const calls: string[] = [];
    const priceRows = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 3, 25 + index)).toISOString().slice(0, 10);
      const close = 10 + index * 0.1;
      return [date, String(close - 0.05), String(close), String(close + 0.1), String(close - 0.1), '1000'];
    });
    const blockRows = priceRows.slice(-30).map((row) => (
      `${String(row[0]).replaceAll('-', '')},${row[1]},${row[3]},${row[4]},${row[2]},1000,2000,,,,0`
    )).join(';');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/dataapi/limit_up/block_top')) {
        return new Response(JSON.stringify({
          data: [{
            code: '885531',
            name: '光伏概念',
            change: 2.5,
            limit_up_num: 2,
            continuous_plate_num: 2,
            stock_list: [
              { code: '600088', name: '测试沪股', continue_num: 2, reason_type: '测试', latest: 12, change_rate: 10 },
              { code: '000099', name: '测试深股', continue_num: 1, reason_type: '测试', latest: 8, change_rate: 9.9 },
            ],
          }],
        }), { status: 200 });
      }
      if (url.includes('d.10jqka.com.cn/v4/line/bk_885531/')) {
        return new Response(`callback({"name":"光伏概念","data":"${blockRows}"})`, { status: 200 });
      }
      if (url.includes('web.ifzq.gtimg.cn')) {
        const symbol = new URL(url).searchParams.get('param')?.split(',')[0] ?? '';
        return new Response(`kline_dayqfq=${JSON.stringify({ code: 0, data: { [symbol]: { qfqday: priceRows } } })}`, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    try {
      const started = await http.get('/api/analysis?refresh=1&date=20260723').expect(202);
      const task = await waitForTask(started.body.task_id);
      expect(task.status).toBe('completed');
      expect(task.message).toContain('blocktop 1 个板块');
      expect(calls.some((url) => url.includes('/dataapi/limit_up/block_top'))).toBe(true);
      expect(calls.some((url) => url.includes('param=sh600088'))).toBe(true);
      expect(calls.some((url) => url.includes('param=sz000099'))).toBe(true);
      expect(calls.some((url) => url.includes('param=sh000001'))).toBe(true);
      expect(await store.getStockPrices('600088', 5)).toHaveLength(5);
      const latest = await http.get('/api/limit_up?date=20260723').expect(200);
      expect(latest.body.map((record: { stock_code: string }) => record.stock_code).sort()).toEqual(['000099', '600088']);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('gracefully preserves the existing snapshot when blocktop is unavailable', async () => {
    const before = await store.getLimitUpByDate('20260723');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    try {
      const started = await http.get('/api/analysis?refresh=1&date=20260724').expect(202);
      const task = await waitForTask(started.body.task_id);
      expect(task.status).toBe('completed');
      expect(task.message).toContain('blocktop 数据不可用');
      expect(await store.getLimitUpByDate('20260723')).toEqual(before);
      expect(await store.getLimitUpByDate('20260724')).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('auto-fetches missing date coverage for simulated trading, ranking and backtest', async () => {
    const workflowRoot = await mkdtemp(path.join(os.tmpdir(), 'trending-polars-coverage-'));
    const workflowStore = new DataStore(workflowRoot);
    const workflowBroker = new FakeSimulatedBroker();
    const workflowPaper = new PaperTradingService(workflowBroker, {
      now: () => new Date('2026-07-23T10:00:00+08:00'),
    });
    const workflowApp = createApp({
      store: workflowStore,
      tasks: new TaskRegistry(),
      paper: workflowPaper,
    });
    const workflowHttp = request(workflowApp.app);
    await workflowStore.saveAnalysis(apiAnalysisFixture(), '20260722');
    await workflowStore.saveRanking({
      timestamp: '2026-07-22 15:05:00',
      date: '20260722',
      total_stocks: 2,
      rankings: apiRankingFixture().slice(0, 2),
    });

    const calls: string[] = [];
    const rows = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 3, 25 + index)).toISOString().slice(0, 10);
      const close = 10 + index * 0.08;
      return [date, String(close - 0.03), String(close), String(close + 0.08), String(close - 0.08), '1200'];
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('web.ifzq.gtimg.cn')) {
        const symbol = new URL(url).searchParams.get('param')?.split(',')[0] ?? '';
        return new Response(`kline_dayqfq=${JSON.stringify({ code: 0, data: { [symbol]: { qfqday: rows } } })}`, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    try {
      await workflowHttp.get('/api/simulated-trading/overview').expect(200);
      expect(calls.some((url) => url.includes('param=sh000001'))).toBe(true);
      expect(calls.some((url) => url.includes('param=sh600001'))).toBe(true);
      expect(calls.some((url) => url.includes('param=sz000002'))).toBe(true);

      const beforeRanking = calls.length;
      const rankingStarted = await workflowHttp.post('/api/ranking/compute?date=20260723').expect(202);
      const rankingTask = await waitForTaskFrom(workflowHttp, rankingStarted.body.task_id);
      expect(rankingTask.status).toBe('completed');
      expect(rankingTask.result).toMatchObject({ date: '20260723', collected: true });
      expect(calls.length).toBeGreaterThan(beforeRanking);

      const beforeBacktest = calls.length;
      const backtestStarted = await workflowHttp.post('/api/backtest/run?mode=random&days=60&strategy_count=8&max_hold_days=5&max_positions=8&position_size_pct=12&take_profit_pct=15&stop_loss_pct=5&trend_weight_pct=100&volume_price_weight_pct=100&volatility_weight_pct=100&date=20260723').expect(202);
      const backtestTask = await waitForTaskFrom(workflowHttp, backtestStarted.body.task_id);
      expect(backtestTask.status).toBe('completed');
      expect(backtestTask.result).toMatchObject({ collected: true, run_id: expect.any(String) });
      expect(calls.length).toBeGreaterThan(beforeBacktest);
    } finally {
      fetchSpy.mockRestore();
      workflowStore.close();
      await rm(workflowRoot, { recursive: true, force: true });
    }
  });

  it('runs randomized backtests as separate saved runs', async () => {
    const started = await http.post('/api/backtest/run?mode=random&days=10&strategy_count=12&max_hold_days=3&max_positions=5&position_size_pct=20&take_profit_pct=15&stop_loss_pct=5&trend_weight_pct=100&volume_price_weight_pct=100&distance_from_low_weight_pct=100&volatility_weight_pct=100&date=20260722').expect(202);
    const task = await waitForTask(started.body.task_id);
    expect(task.status).toBe('completed');
    expect(task.result.run_ids).toHaveLength(12);
    expect(task.message).toContain('12 组随机组合回测');
    const list = await http.get('/api/backtest/list').expect(200);
    const saved = list.body.filter((item: { run_id: string }) => task.result.run_ids.includes(item.run_id));
    expect(saved).toHaveLength(12);
    expect(saved.find((item: { combo_index: number }) => item.combo_index === 1)).toMatchObject({
      mode: 'random',
      combo_index: 1,
      strategy_count: 12,
    });
    const results = await Promise.all(task.result.run_ids.map((id: string) => http.get(`/api/backtest/${id}`).expect(200).then((res) => res.body)));
    const result = results.find((item) => item.trades.length > 0) ?? results[0];
    expect(results.some((item) => item.trades.length > 0)).toBe(true);
    expect(result.summary.total_trades).toBe(result.trades.length);
    expect(result.config).toMatchObject({
      mode: 'random',
      days: 10,
      strategy_count: 12,
      max_hold_days_upper: 3,
      max_positions_upper: 5,
      position_size_upper_pct: 20,
      take_profit_upper_pct: 15,
      stop_loss_upper_pct: 5,
      trend_weight_upper_pct: 100,
      volume_price_weight_upper_pct: 100,
      distance_from_low_weight_upper_pct: 100,
      volatility_weight_upper_pct: 100,
    });
    expect(result.config.trend_weight_pct).toBeGreaterThanOrEqual(1);
    expect(result.config.trend_weight_pct).toBeLessThanOrEqual(100);
    expect(result.config.distance_from_low_weight_pct).toBeGreaterThanOrEqual(1);
    expect(result.config.distance_from_low_weight_pct).toBeLessThanOrEqual(100);
  });

  it('runs a current-scheme backtest with exact parameters', async () => {
    const started = await http.post('/api/backtest/run?mode=current&days=10&max_hold_days=3&max_positions=5&position_size_pct=10&take_profit_pct=15&stop_loss_pct=5&trend_weight_pct=60&volume_price_weight_pct=80&distance_from_low_weight_pct=70&volatility_weight_pct=100&date=20260722').expect(202);
    const task = await waitForTask(started.body.task_id);
    expect(task.status).toBe('completed');
    const runId = task.result.run_id;
    const result = await http.get(`/api/backtest/${runId}`).expect(200);
    expect(result.body.trades.length).toBeGreaterThan(0);
    expect(result.body.config).toMatchObject({
      mode: 'current',
      days: 10,
      strategy_count: 1,
      max_hold_days: 3,
      max_positions: 5,
      position_size_pct: 10,
      take_profit_pct: 15,
      stop_loss_pct: -5,
      trend_weight_pct: 60,
      volume_price_weight_pct: 80,
      distance_from_low_weight_pct: 70,
      volatility_weight_pct: 100,
    });
    expect(typeof result.body.config.scoring_config_json).toBe('string');
  });

  it('applies a saved backtest strategy to simulated trading', async () => {
    const started = await http.post('/api/backtest/run?mode=current&days=10&max_hold_days=4&max_positions=6&position_size_pct=12&take_profit_pct=18&stop_loss_pct=6&date=20260722').expect(202);
    const task = await waitForTask(started.body.task_id);
    expect(task.status).toBe('completed');
    const runId = task.result.run_id;
    const applied = await http.post('/api/simulated-trading/strategy/apply-backtest').send({ run_id: runId }).expect(200);
    expect(applied.body).toMatchObject({
      ok: true,
      run_id: runId,
      strategy: {
        maxHoldDays: 4,
        maxPositions: 6,
        positionSizePct: 12,
        takeProfitPct: 18,
        stopLossPct: -6,
      },
      plan: {
        max_hold_days: 4,
        max_positions: 6,
        position_size_pct: 12,
        take_profit_pct: 18,
        stop_loss_pct: -6,
      },
      ranking: {
        trendWeightPct: 100,
        volumePriceWeightPct: 100,
        distanceFromLowWeightPct: 100,
        volatilityTrendWeightPct: 100,
      },
      ranking_recomputed: true,
    });
    const savedRankingConfig = await store.getRankingConfig();
    expect(savedRankingConfig).toMatchObject({
      applied_backtest_run_id: runId,
      factor_weights: {
        trendWeightPct: 100,
        volumePriceWeightPct: 100,
        distanceFromLowWeightPct: 100,
        volatilityTrendWeightPct: 100,
      },
    });
    const overview = await http.get('/api/simulated-trading/overview').expect(200);
    expect(overview.body.plan).toMatchObject({
      position_size_pct: 12,
      max_positions: 6,
      max_hold_days: 4,
      stop_loss_pct: -6,
      take_profit_pct: 18,
    });
    const bootstrap = await http.get('/api/simulated-trading/bootstrap').expect(200);
    expect(bootstrap.body.overview.plan).toMatchObject({
      position_size_pct: 12,
      max_positions: 6,
      max_hold_days: 4,
      stop_loss_pct: -6,
      take_profit_pct: 18,
    });
    const state = await http.get('/api/simulated-trading/state').expect(200);
    expect(state.body.applied_backtest_run_id).toBe(runId);
    expect(state.body.strategy_config).toMatchObject({
      maxHoldDays: 4,
      maxPositions: 6,
      positionSizePct: 12,
      takeProfitPct: 18,
      stopLossPct: -6,
    });
  });

  it('serves the simulated-trading page bootstrap without waiting for or querying Tonghuashun', async () => {
    const callsBefore = simulatedBroker.snapshotCalls;
    const bootstrap = await http.get('/api/simulated-trading/bootstrap').expect(200);
    expect(simulatedBroker.snapshotCalls).toBe(callsBefore);
    expect(bootstrap.headers['cache-control']).toBe('no-store');
    expect(bootstrap.body.overview.connection).toMatchObject({ source: 'runtime-state' });
    expect(bootstrap.body.overview.plan.history).toEqual(expect.any(Array));
    expect(bootstrap.body.automation).toMatchObject({ enabled: expect.any(Boolean) });
  });

  it('executes the simulated-trading open window immediately and persists the state', async () => {
    const overview = await http.get('/api/simulated-trading/overview').expect(200);
    expect(overview.body.plan).toBeTruthy();
    expect(overview.body.account.positions).toEqual([]);
    expect(overview.body.account.current_position_pct).toBe(0);
    expect(overview.body.account.pnl_summary).toEqual({ amount: 0, pct: 0 });
    const accepted = await http.post('/api/simulated-trading/execute').expect(200);
    expect(accepted.body.ok).toBe(true);
    const state = await http.get('/api/simulated-trading/state').expect(200);
    expect(state.body).toMatchObject({ schema_version: 1, engine_version: 'node-t1-live-v1' });
    expect(state.body.completed_windows['20260724']).toContain('open');
  });

  it('routes indices/stocks through multi-source qfq and block indices through Tonghuashun', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('web.ifzq.gtimg.cn')) {
        return new Response('kline_dayqfq={"code":0,"data":{"sh000300":{"qfqday":[["2026-07-22","4000","4050","4060","3990","100"]]}}}', { status: 200 });
      }
      if (url.includes('d.10jqka.com.cn/v4/line/bk_885531/01/last.js')) {
        return new Response('callback({"name":"光伏概念","data":"20260722,100,110,90,105,1000,2000,,,,0"})', { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    try {
      const index = await http.get('/api/index_prices?symbol=sh000300&limit=5').expect(200);
      expect(index.headers['x-market-data-source']).toBe('tencent');
      expect(index.body[0]).toMatchObject({ close: 4050, volume: 10_000 });

      const block = await http.get('/api/block_prices?block_code=885531&period=01&limit=5').expect(200);
      expect(block.headers['x-market-data-source']).toBe('ths-block');
      expect(block.body[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 105, volume: 1000, amount: 2000 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('falls back to persisted SQLite prices when every network source fails', async () => {
    await store.upsertIndexPrices('sh000300', '沪深300', [{
      date: '20260722',
      open: 4000,
      close: 4050,
      high: 4060,
      low: 3990,
      volume: 10_000,
      amount: 40_500_000,
      changeRate: 1.25,
    }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    try {
      const index = await http.get('/api/index_prices?symbol=sh000300&limit=5').expect(200);
      expect(index.headers['x-market-data-source']).toBe('sqlite');
      expect(index.body).toEqual(expect.arrayContaining([expect.objectContaining({ close: 4050 })]));

      const stock = await http.get('/api/stock_prices?stock_code=600001&limit=5').expect(200);
      expect(stock.headers['x-market-data-source']).toBe('sqlite');
      expect(stock.body).toHaveLength(5);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('deletes a JSON-archived backtest without touching SQLite market data', async () => {
    const runId = '20260718_235624';
    const deleted = await http.delete(`/api/backtest/${runId}`).expect(200);
    expect(deleted.body.success).toBe(true);
    await http.get(`/api/backtest/${runId}`).expect(404);
  });

  it('exposes structured audit records with request trace ids', async () => {
    const response = await http.get('/api/audit/logs?component=http&limit=20').expect(200);
    expect(response.headers['x-trace-id']).toBeTruthy();
    expect(response.body.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'http', event: 'request_started', trace_id: expect.any(String) }),
    ]));
    const files = await http.get('/api/audit/files').expect(200);
    expect(files.body.files.length).toBeGreaterThan(0);
  });
});
