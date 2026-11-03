import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { NOOP_AUDIT_LOGGER } from '../server/audit-log.js';
import { DataStore } from '../server/data-store.js';
import { PaperTradingService } from '../server/paper-trading.js';
import { TaskRegistry } from '../server/tasks.js';
import { MiningStore } from '../server/pipeline/store.js';
import type { MiningResult, MiningRun } from '../server/pipeline/types.js';
import type { SimulatedAccountSnapshot, SimulatedBroker } from '../server/ths-simulated-broker.js';
import type { PaperOrder } from '../src/types.js';

class FakeBroker implements SimulatedBroker {
  async snapshot(): Promise<SimulatedAccountSnapshot> {
    return { availableCash: 100_000, totalAssets: 100_000, positions: [], orders: [] };
  }
  async snapshotAccountOnly(): Promise<SimulatedAccountSnapshot> { return this.snapshot(); }
  async quote(): Promise<number> { return 10; }
  async placeOrder(_order: PaperOrder) { return { verified: true, brokerOutput: 'OK' }; }
  async cancelOrder() { return { verified: true, brokerOutput: 'OK' }; }
}

const RUN_ID = 'mining-20260101-000000-abcd1234';

function makeMetrics() {
  return {
    annualReturn: 0,
    maxDrawdown: 0,
    sharpe: 0,
    winRate: 0,
    profitFactor: 0,
    tradeCount: 0,
    turnover: 0,
  };
}

describe('/api/mining 路由', () => {
  let root = '';
  let store: DataStore;
  let http: ReturnType<typeof request>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'trending-polars-mining-'));
    store = new DataStore(root);
    const built = createApp({
      store,
      tasks: new TaskRegistry(),
      paper: new PaperTradingService(new FakeBroker()),
      audit: NOOP_AUDIT_LOGGER as never,
    });
    http = request(built.app);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  async function seedRun() {
    const miningStore = new MiningStore(path.join(root, 'mining'));
    const run: MiningRun = {
      runId: RUN_ID,
      createdAt: '2026-01-01 00:00:00',
      codeVersion: 'abc123',
      dataVersion: '20260101-deadbeefcafe',
      universe: ['600001'],
      strategies: ['ma-trend'],
      config: { days: 60 },
      status: 'success',
    };
    const result: MiningResult = {
      runId: RUN_ID,
      params: { maxHoldDays: 5, takeProfitPct: 15, stopLossPct: -5 },
      inSample: makeMetrics(),
      outOfSample: makeMetrics(),
      stabilityScore: 80,
      tradeCount: 30,
      rank: 1,
      outOfSampleDays: 20,
    };
    await miningStore.saveRun(run);
    await miningStore.saveResults(RUN_ID, [result]);
  }

  it('列出挖掘批次', async () => {
    await seedRun();
    const response = await http.get('/api/mining/runs').expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.runs[0]).toMatchObject({
      run_id: RUN_ID,
      status: 'success',
      candidate_count: 1,
    });
  });

  it('批次不存在时返回 404', async () => {
    await http.get('/api/mining/runs/missing').expect(404);
  });

  it('下发缺少操作人或确认串时返回 400', async () => {
    await seedRun();
    const noOperator = await http.post('/api/mining/deploy').send({
      run_id: RUN_ID,
      rank: 1,
      confirmation: RUN_ID,
    }).expect(400);
    expect(noOperator.body.error).toContain('操作人');

    const noConfirmation = await http.post('/api/mining/deploy').send({
      run_id: RUN_ID,
      rank: 1,
      operator: '张三',
    }).expect(400);
    expect(noConfirmation.body.error).toContain('显式确认');
  });

  it('确认串与 runId 不一致时拒绝下发', async () => {
    await seedRun();
    const response = await http.post('/api/mining/deploy').send({
      run_id: RUN_ID,
      rank: 1,
      operator: '张三',
      confirmation: 'wrong',
    }).expect(400);
    expect(response.body.error).toContain('显式确认');
  });

  it('成功下发后实例可查，配置带齐来源批次与操作人', async () => {
    await seedRun();
    const deployed = await http.post('/api/mining/deploy').send({
      run_id: RUN_ID,
      rank: 1,
      operator: '张三',
      confirmation: RUN_ID,
    }).expect(201);

    expect(deployed.body.instance).toMatchObject({
      sourceRunId: RUN_ID,
      sourceRank: 1,
      operator: '张三',
      channel: 'simulated',
      universe: ['600001'],
      strategyIds: ['ma-trend'],
    });
    const instanceId = deployed.body.instance.instanceId;

    const list = await http.get('/api/mining/instances').expect(200);
    expect(list.body.total).toBe(1);

    const detail = await http.get(`/api/mining/instances/${instanceId}`).expect(200);
    expect(detail.body.instance.instanceId).toBe(instanceId);
    expect(detail.body.state).toBeNull();
  });

  it('实例不存在时返回 404', async () => {
    await http.get('/api/mining/instances/missing').expect(404);
    await http.get('/api/mining/instances/missing/validation').expect(404);
  });

  it('验证报告在实例尚无成交时给出提示而不报错', async () => {
    await seedRun();
    const deployed = await http.post('/api/mining/deploy').send({
      run_id: RUN_ID,
      rank: 1,
      operator: '张三',
      confirmation: RUN_ID,
    }).expect(201);
    const instanceId = deployed.body.instance.instanceId;

    const response = await http.get(`/api/mining/instances/${instanceId}/validation`).expect(200);
    expect(response.body).toMatchObject({
      runId: RUN_ID,
      rank: 1,
      status: 'pass',
    });
    expect(response.body.warnings).toContain('实例尚无成交记录，无法给出实测指标');
    expect(response.body.comparisons.map((item: { key: string }) => item.key)).toEqual([
      'annualReturn',
      'maxDrawdown',
      'winRate',
      'tradeFrequency',
    ]);
  });

  it('返回校准数据列表', async () => {
    const miningStore = new MiningStore(path.join(root, 'mining'));
    await miningStore.saveCalibration({
      runId: 'run-prev',
      createdAt: '2026-01-01 00:00:00',
      slippageRate: 0.01,
      unfilledRate: 0.02,
      cancelRate: 0.01,
      sampleSize: 12,
    });
    const response = await http.get('/api/mining/calibration').expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.latest.runId).toBe('run-prev');
  });
});
