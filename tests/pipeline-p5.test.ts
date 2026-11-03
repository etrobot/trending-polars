import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaperStrategyInstruction } from '../src/types.js';
import { buildInstanceConfig, MiningInstanceStore, type MiningDeployRequest } from '../server/pipeline/deploy.js';
import { calibrationFromFriction, computeFrictionStats } from '../server/pipeline/friction.js';
import { MiningStore } from '../server/pipeline/store.js';
import { buildValidationReport } from '../server/pipeline/validation.js';
import { miningParamsToStrategyConfig } from '../server/trading-strategy.js';
import type { MiningResult, MiningRun } from '../server/pipeline/types.js';
import type { PerformanceMetrics } from '../server/metrics/performance.js';

const RUN_ID = 'mining-20260101-000000-abcd1234';

function makeRun(overrides: Partial<MiningRun> = {}): MiningRun {
  return {
    runId: RUN_ID,
    createdAt: '2026-01-01 00:00:00',
    codeVersion: 'abc123',
    dataVersion: '20260101-deadbeefcafe',
    universe: ['600001', '000002'],
    strategies: ['ma-trend'],
    config: {},
    status: 'success',
    ...overrides,
  };
}

function makeResult(overrides: Partial<MiningResult> = {}): MiningResult {
  return {
    runId: RUN_ID,
    params: { maxHoldDays: 5, takeProfitPct: 15, stopLossPct: -5 },
    inSample: metrics({ annualReturn: 12 }),
    outOfSample: metrics({ annualReturn: 10 }),
    stabilityScore: 80,
    tradeCount: 40,
    rank: 1,
    outOfSampleDays: 20,
    ...overrides,
  };
}

function metrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    annualReturn: 0,
    maxDrawdown: 0,
    sharpe: 0,
    winRate: 0,
    profitFactor: 0,
    tradeCount: 0,
    turnover: 0,
    ...overrides,
  };
}

function instruction(overrides: Partial<PaperStrategyInstruction> = {}): PaperStrategyInstruction {
  return {
    id: 'ins-1',
    signal_date: '20260101',
    side: 'buy',
    stock_code: '600001',
    stock_name: '样本甲',
    signal_price: 10,
    quantity: 100,
    status: 'filled',
    reason: '测试',
    created_at: '2026-01-01 10:00:00',
    ...overrides,
  };
}

describe('候选参数下发（deploy）', () => {
  const baseRequest: MiningDeployRequest = {
    runId: RUN_ID,
    rank: 1,
    operator: '张三',
    confirmation: RUN_ID,
  };

  it('缺少操作人时拒绝下发', () => {
    expect(() => buildInstanceConfig({ ...baseRequest, operator: '  ' }, makeRun(), makeResult()))
      .toThrow(/操作人/);
  });

  it('确认串与 runId 不一致时拒绝下发', () => {
    expect(() => buildInstanceConfig({ ...baseRequest, confirmation: 'other' }, makeRun(), makeResult()))
      .toThrow(/显式确认/);
  });

  it('排名序号与结果不匹配时拒绝下发', () => {
    expect(() => buildInstanceConfig({ ...baseRequest, rank: 2 }, makeRun(), makeResult()))
      .toThrow(/排名序号/);
  });

  it('失败的挖掘批次不能下发', () => {
    expect(() => buildInstanceConfig(baseRequest, makeRun({ status: 'failed' }), makeResult()))
      .toThrow(/成功的挖掘批次/);
  });

  it('资金上限非正数时拒绝下发', () => {
    expect(() => buildInstanceConfig({ ...baseRequest, capitalLimit: 0 }, makeRun(), makeResult()))
      .toThrow(/资金上限/);
  });

  it('标的池为空时拒绝下发', () => {
    expect(() => buildInstanceConfig(
      { ...baseRequest, universe: [' '] },
      makeRun(),
      makeResult(),
    )).toThrow(/标的池/);
  });

  it('成功下发时补齐配置并记录操作人与时间', () => {
    const now = new Date('2026-02-03T04:05:06.000Z');
    const config = buildInstanceConfig(baseRequest, makeRun(), makeResult(), { now: () => now });
    expect(config.instanceId.startsWith('mining-inst-')).toBe(true);
    expect(config.sourceRunId).toBe(RUN_ID);
    expect(config.sourceRank).toBe(1);
    expect(config.operator).toBe('张三');
    expect(config.createdAt).toBe(now.toISOString());
    expect(config.params).toEqual({ maxHoldDays: 5, takeProfitPct: 15, stopLossPct: -5 });
    expect(config.universe).toEqual(['600001', '000002']);
    expect(config.strategyIds).toEqual(['ma-trend']);
    expect(config.capitalLimit).toBe(100_000);
    expect(config.channel).toBe('simulated');
  });

  it('显式覆盖标的池与子策略时以覆盖值为准', () => {
    const config = buildInstanceConfig(
      { ...baseRequest, universe: ['300003', '300003'], strategyIds: ['ma-trend', 'breakout'] },
      makeRun(),
      makeResult(),
    );
    expect(config.universe).toEqual(['300003']);
    expect(config.strategyIds).toEqual(['ma-trend', 'breakout']);
  });
});

describe('实例配置落库（MiningInstanceStore）', () => {
  let root = '';
  let store: MiningInstanceStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mining-inst-'));
    store = new MiningInstanceStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('落库后可读回并支持更新与列表', async () => {
    const config = buildInstanceConfig(
      { runId: RUN_ID, rank: 1, operator: '李四', confirmation: RUN_ID },
      makeRun(),
      makeResult(),
    );
    await store.save(config);

    const loaded = await store.get(config.instanceId);
    expect(loaded?.operator).toBe('李四');

    const updated = await store.update(config.instanceId, { status: 'active' });
    expect(updated.status).toBe('active');
    expect(updated.operator).toBe('李四');

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].instanceId).toBe(config.instanceId);
  });

  it('读取不存在的实例返回 null，更新则抛错', async () => {
    expect(await store.get('missing')).toBeNull();
    await expect(store.update('missing', { status: 'active' })).rejects.toThrow(/实例不存在/);
  });
});

describe('挖掘参数映射（miningParamsToStrategyConfig）', () => {
  it('把挖掘参数映射为策略覆盖项', () => {
    const overrides = miningParamsToStrategyConfig({
      maxHoldDays: 7,
      maxPositions: 6,
      positionSizePct: 12,
      takeProfitPct: 20,
      stopLossPct: -8,
      minEntryScore: 55,
    });
    expect(overrides).toEqual({
      maxHoldDays: 7,
      maxPositions: 6,
      positionSizePct: 12,
      takeProfitPct: 20,
      stopLossPct: -8,
      minEntryScore: 55,
    });
  });

  it('正数止损归一为负号，非法值与未知键被忽略', () => {
    const overrides = miningParamsToStrategyConfig({
      stopLossPct: 8,
      maxHoldDays: Number.NaN,
      takeProfitPct: 0,
      unknownKey: 3,
    });
    expect(overrides.stopLossPct).toBe(-8);
    expect(overrides.maxHoldDays).toBeUndefined();
    expect(overrides.takeProfitPct).toBeUndefined();
    expect(Object.keys(overrides)).toEqual(['stopLossPct']);
  });
});

describe('成交摩擦统计（friction）', () => {
  it('买入以成交价高于信号价为不利方向，卖出取反', () => {
    const stats = computeFrictionStats([
      instruction({ side: 'buy', signal_price: 10, execution_price: 10.1 }),
      instruction({ side: 'sell', signal_price: 10, execution_price: 9.9 }),
    ]);
    expect(stats.slippageSamples).toBe(2);
    expect(stats.avgSlippageRate).toBeCloseTo(0.01, 4);
    expect(stats.maxSlippageRate).toBeCloseTo(0.01, 4);
  });

  it('未提交券商的 pending/skipped 不计入分母', () => {
    const stats = computeFrictionStats([
      instruction({ status: 'pending' }),
      instruction({ status: 'skipped' }),
      instruction({ status: 'filled' }),
      instruction({ status: 'expired' }),
      instruction({ status: 'cancelled' }),
    ]);
    expect(stats.attempted).toBe(3);
    expect(stats.filled).toBe(1);
    expect(stats.unfilled).toBe(1);
    expect(stats.cancelled).toBe(1);
    expect(stats.unfilledRate).toBeCloseTo(1 / 3, 4);
    expect(stats.cancelRate).toBeCloseTo(1 / 3, 4);
    expect(stats.fillRate).toBeCloseTo(1 / 3, 4);
  });

  it('样本量不足时校准数据为 null', () => {
    const stats = computeFrictionStats([
      instruction({ status: 'filled', signal_price: 10, execution_price: 10.05 }),
    ]);
    expect(calibrationFromFriction(RUN_ID, '2026-01-01 00:00:00', stats)).toBeNull();
  });

  it('样本量足够时生成校准数据', () => {
    const stats = computeFrictionStats(Array.from({ length: 6 }, () => instruction({
      status: 'filled',
      signal_price: 10,
      execution_price: 10.1,
    })));
    const calibration = calibrationFromFriction(RUN_ID, '2026-01-01 00:00:00', stats);
    expect(calibration).not.toBeNull();
    expect(calibration?.runId).toBe(RUN_ID);
    expect(calibration?.sampleSize).toBe(6);
    expect(calibration?.slippageRate).toBeCloseTo(0.01, 4);
  });
});

describe('校准数据落库（MiningStore）', () => {
  let root = '';
  let store: MiningStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mining-cal-'));
    store = new MiningStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('保存后可列出并取到最新一条', async () => {
    await store.saveCalibration({
      runId: 'run-old',
      createdAt: '2026-01-01 00:00:00',
      slippageRate: 0.01,
      unfilledRate: 0.02,
      cancelRate: 0.01,
      sampleSize: 20,
    });
    await store.saveCalibration({
      runId: 'run-new',
      createdAt: '2026-02-01 00:00:00',
      slippageRate: 0.02,
      unfilledRate: 0.03,
      cancelRate: 0.01,
      sampleSize: 30,
    });

    const list = await store.listCalibrations();
    expect(list).toHaveLength(2);
    expect(list[0].runId).toBe('run-new');

    const latest = await store.getLatestCalibration();
    expect(latest?.runId).toBe('run-new');
    expect(latest?.slippageRate).toBe(0.02);
  });

  it('没有校准数据时返回 null', async () => {
    expect(await store.getLatestCalibration()).toBeNull();
  });
});

describe('验证报告（validation）', () => {
  const config = {
    instanceId: 'mining-inst-1',
    createdAt: '2026-01-01 00:00:00',
    operator: '张三',
    sourceRunId: RUN_ID,
    sourceRank: 1,
    params: { maxHoldDays: 5 },
    universe: ['600001'],
    capitalLimit: 100_000,
    strategyIds: ['ma-trend'],
    status: 'created' as const,
    channel: 'simulated' as const,
  };

  const friction = computeFrictionStats([]);

  it('偏差超过 30% 时标红并给出可能原因', () => {
    const report = buildValidationReport({
      config,
      predicted: metrics({ annualReturn: 20, maxDrawdown: -10, winRate: 60, tradeCount: 40 }),
      predictedOutOfSampleDays: 20,
      actual: metrics({ annualReturn: 5, maxDrawdown: -10, winRate: 60, tradeCount: 40 }),
      actualTradingDays: 20,
      friction: {
        ...friction,
        avgSlippageRate: 0.01,
        unfilledRate: 0.2,
      },
    });

    expect(report.status).toBe('deviated');
    const returns = report.comparisons.find((item) => item.key === 'annualReturn')!;
    expect(returns.exceeded).toBe(true);
    expect(returns.deviation).toBeCloseTo(0.75, 4);
    expect(report.comparisons.find((item) => item.key === 'maxDrawdown')!.exceeded).toBe(false);
    expect(report.possibleCauses.some((cause) => cause.includes('滑点'))).toBe(true);
    expect(report.possibleCauses.some((cause) => cause.includes('流动性'))).toBe(true);
  });

  it('实测交易频率显著低于预测时提示信号延迟', () => {
    const report = buildValidationReport({
      config,
      predicted: metrics({ annualReturn: 20, tradeCount: 40 }),
      predictedOutOfSampleDays: 20,
      actual: metrics({ annualReturn: 20, tradeCount: 4 }),
      actualTradingDays: 20,
      friction,
    });
    expect(report.possibleCauses.some((cause) => cause.includes('信号延迟'))).toBe(true);
    expect(report.comparisons.find((item) => item.key === 'tradeFrequency')!.exceeded).toBe(true);
  });

  it('各项均在阈值内时状态为 pass', () => {
    const report = buildValidationReport({
      config,
      predicted: metrics({ annualReturn: 20, maxDrawdown: -10, winRate: 60, tradeCount: 40 }),
      predictedOutOfSampleDays: 20,
      actual: metrics({ annualReturn: 21, maxDrawdown: -9, winRate: 58, tradeCount: 40 }),
      actualTradingDays: 20,
      friction,
    });
    expect(report.status).toBe('pass');
    expect(report.comparisons.every((item) => !item.exceeded)).toBe(true);
  });

  it('样本量不足时给出提示，实测无成交时不报错', () => {
    const report = buildValidationReport({
      config,
      predicted: metrics({ tradeCount: 3 }),
      predictedOutOfSampleDays: 20,
      actual: metrics({ tradeCount: 0 }),
      actualTradingDays: 0,
      friction,
    });
    expect(report.warnings).toContain('样本量不足，指标参考意义有限');
    expect(report.warnings).toContain('实例尚无成交记录，无法给出实测指标');
    expect(report.runId).toBe(RUN_ID);
    expect(report.rank).toBe(1);
  });
});
