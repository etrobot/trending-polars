import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { DataStore, DEFAULT_DATA_DIR } from '../server/data-store.js';
import { PaperTradingService } from '../server/paper-trading.js';
import { TaskRegistry } from '../server/tasks.js';
import type { SimulatedAccountSnapshot, SimulatedBroker } from '../server/ths-simulated-broker.js';
import type { PaperOrder } from '../src/types.js';
import { historicalFixture } from './historical-fixture.js';

let root = '';
let http: ReturnType<typeof request>;
let simulatedBroker: FakeSimulatedBroker;

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

async function waitForTask(taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await http.get(`/api/tasks/${taskId}`);
    if (['completed', 'failed', 'cancelled'].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${taskId} did not finish`);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'trending-polars-test-'));
  await mkdir(path.join(root, 'backtests'), { recursive: true });
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  await copyFile(path.join(DEFAULT_DATA_DIR, 'analysis.json'), path.join(root, 'analysis.json'));
  await copyFile(path.join(DEFAULT_DATA_DIR, 'ranking.json'), path.join(root, 'ranking.json'));
  for (const file of await readdir(path.join(DEFAULT_DATA_DIR, 'backtests'))) {
    await copyFile(path.join(DEFAULT_DATA_DIR, 'backtests', file), path.join(root, 'backtests', file));
  }
  const store = new DataStore(root);
  await store.saveHistoricalMarket(historicalFixture());
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
  await rm(root, { recursive: true, force: true });
});

describe('Trending Polars API', () => {
  it('exposes health and enriched analysis data', async () => {
    const health = await http.get('/api/health').expect(200);
    expect(health.body.stack).toContain('nodejs-polars');
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
    const started = await http.post('/api/ranking/compute').expect(202);
    const task = await waitForTask(started.body.task_id);
    expect(task.status).toBe('completed');
    const ranking = await http.get('/api/ranking?page_size=5').expect(200);
    expect(ranking.body.rankings).toHaveLength(5);
  });

  it('runs a Polars-backed backtest and exposes its ledger', async () => {
    const started = await http.post('/api/backtest/run?days=10&max_hold_days=3').expect(202);
    const task = await waitForTask(started.body.task_id);
    expect(task.status).toBe('completed');
    const runId = task.result.run_id;
    const result = await http.get(`/api/backtest/${runId}`).expect(200);
    expect(result.body.trades.length).toBeGreaterThan(0);
    expect(result.body.summary.total_trades).toBe(result.body.trades.length);
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

  it('keeps simulated trading behind explicit confirmation', async () => {
    const overview = await http.get('/api/simulated-trading/overview').expect(200);
    expect(overview.body.plan).toBeTruthy();
    expect(overview.body.account.positions).toEqual([]);
    expect(overview.body.account.current_position_pct).toBe(0);
    expect(overview.body.account.pnl_summary).toEqual({ amount: 0, pct: 0 });
    const rejected = await http.post('/api/simulated-trading/execute').send({ confirmation: 'REAL' }).expect(400);
    expect(rejected.body.ok).toBe(false);
    const accepted = await http.post('/api/simulated-trading/execute').send({ confirmation: 'SIMULATED' }).expect(200);
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

  it('deletes a backtest through the runtime tombstone without touching the seed contract', async () => {
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
