import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assessDataQuality, DEFAULT_QUALITY_THRESHOLDS } from '../server/pipeline/quality.js';
import { renderMiningReportHtml } from '../server/pipeline/report.js';
import { replayMiningRun } from '../server/pipeline/replay.js';
import { MiningStore } from '../server/pipeline/store.js';
import { runMiningPipeline } from '../server/pipeline/mine.js';
import type { MiningReport, MiningResult, MiningRun } from '../server/pipeline/types.js';
import { historicalFixture } from './historical-fixture.js';

function makeMetrics(overrides: Record<string, number> = {}) {
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

function makeRun(overrides: Partial<MiningRun> = {}): MiningRun {
  return {
    runId: 'mining-1',
    createdAt: '2026-01-01 00:00:00',
    codeVersion: 'abc123',
    dataVersion: '20260101-deadbeefcafe',
    universe: ['600001'],
    strategies: ['ma-trend'],
    config: {},
    status: 'success',
    ...overrides,
  };
}

function makeResult(overrides: Partial<MiningResult> = {}): MiningResult {
  return {
    runId: 'mining-1',
    params: { maxHoldDays: 5, takeProfitPct: 15 },
    inSample: makeMetrics({ sharpe: 1 }),
    outOfSample: makeMetrics({ sharpe: 0.8 }),
    stabilityScore: 70,
    tradeCount: 30,
    rank: 1,
    outOfSampleDays: 20,
    ...overrides,
  };
}

describe('数据质量检查（quality）', () => {
  const fixture = historicalFixture();
  const range = { start: fixture.calendar[0], end: fixture.calendar.at(-1)! };

  it('行情齐全且已复权时判定通过', () => {
    const report = assessDataQuality(
      { ...fixture, limit_up_records: fixture.calendar.map((date) => ({ date, stock_code: '600001' })) },
      ['600001', '000002', '300003', '600004'],
      range,
    );
    expect(report.ok).toBe(true);
    expect(report.adjusted).toBe(true);
    expect(report.priceCoverageRatio).toBe(1);
    expect(report.gaps.priceGaps).toEqual([]);
  });

  it('缺失交易日被显式列出并拉低覆盖率', () => {
    const broken = {
      ...fixture,
      limit_up_records: fixture.calendar.map((date) => ({ date, stock_code: '600001' })),
      stocks: fixture.stocks.map((stock) => (
        stock.stock_code === '000002'
          ? { ...stock, bars: stock.bars.slice(0, -50) }
          : stock
      )),
    };
    const report = assessDataQuality(broken, ['600001', '000002'], range);
    expect(report.ok).toBe(false);
    expect(report.gaps.priceGaps).toHaveLength(1);
    expect(report.gaps.priceGaps[0].stock_code).toBe('000002');
    expect(report.gaps.priceGaps[0].missing_dates.length).toBe(50);
    expect(report.reasons.join(' ')).toContain('行情连续性覆盖率');
  });

  it('未复权行情被拒绝并写入除权问题', () => {
    const report = assessDataQuality(
      {
        ...fixture,
        source: 'eastmoney-unadjusted',
        limit_up_records: fixture.calendar.map((date) => ({ date, stock_code: '600001' })),
      },
      ['600001'],
      range,
    );
    expect(report.ok).toBe(false);
    expect(report.adjusted).toBe(false);
    expect(report.gaps.adjustmentIssues).toHaveLength(1);
    expect(report.reasons.join(' ')).toContain('前复权');
  });

  it('涨停记录缺失被列出并拉低覆盖率', () => {
    const report = assessDataQuality(fixture, ['600001'], range);
    expect(report.ok).toBe(false);
    expect(report.gaps.limitUpMissingDates.length).toBe(fixture.calendar.length);
    expect(report.reasons.join(' ')).toContain('涨停记录覆盖率');
  });

  it('默认阈值为行情 80% / 涨停 60% / 要求复权', () => {
    expect(DEFAULT_QUALITY_THRESHOLDS).toEqual({
      minPriceCoverage: 0.8,
      minLimitUpCoverage: 0.6,
      requireAdjusted: true,
    });
  });
});

describe('挖掘结果落库（store）', () => {
  let root = '';
  let store: MiningStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mining-store-'));
    store = new MiningStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('批次、结果与报告可完整读写', async () => {
    const run = makeRun();
    const results = [makeResult()];
    const report: MiningReport = {
      runId: run.runId,
      createdAt: run.createdAt,
      codeVersion: run.codeVersion,
      dataVersion: run.dataVersion,
      universe: run.universe,
      strategies: run.strategies,
      quality: {
        ok: true,
        asOfDate: '20260722',
        universeSize: 1,
        coveredStocks: 1,
        priceCoverageRatio: 1,
        limitUpCoverageRatio: 1,
        adjusted: true,
        gaps: { priceGaps: [], adjustmentIssues: [], limitUpMissingDates: [] },
        reasons: [],
      },
      warnings: [],
      aggregate: makeMetrics(),
      results,
    };
    const html = renderMiningReportHtml(report);

    await store.saveRun(run);
    await store.saveResults(run.runId, results);
    await store.saveReport(report, html);

    expect((await store.getRun(run.runId))?.codeVersion).toBe('abc123');
    expect((await store.getResults(run.runId))).toHaveLength(1);
    expect((await store.getReport(run.runId))?.runId).toBe(run.runId);
    expect(await store.getReportHtml(run.runId)).toContain('<html');
    expect((await store.listRuns()).map((item) => item.runId)).toEqual([run.runId]);
  });

  it('不存在的批次返回 null / 空数组', async () => {
    expect(await store.getRun('missing')).toBeNull();
    expect(await store.getResults('missing')).toEqual([]);
    expect(await store.getReport('missing')).toBeNull();
    expect(await store.getReportHtml('missing')).toBeNull();
  });
});

describe('挖掘流水线复现（replay）', () => {
  let root = '';
  let store: MiningStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mining-replay-'));
    store = new MiningStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('同数据同配置复现后指标一致且不覆盖原记录', async () => {
    const fixture = historicalFixture();
    const options = {
      universe: ['600001', '000002', '300003', '600004'],
      strategies: ['ma-trend'],
      days: 60,
      grid: { dimensions: { maxHoldDays: [3, 5] } },
      walkforward: { windowSize: 40, stepSize: 20, minTradeCount: 1 },
      thresholds: { minPriceCoverage: 0.8, minLimitUpCoverage: 0, requireAdjusted: true },
    };
    const first = await runMiningPipeline({
      ...options,
      store,
      codeVersion: 'abc123',
      prepareData: async () => fixture,
    });
    expect(first.results.length).toBeGreaterThan(0);

    const outcome = await replayMiningRun(first.run.runId, {
      store,
      prepareData: async () => fixture,
      replayRunId: `${first.run.runId}-replay-test`,
    });

    expect(outcome.identical).toBe(true);
    expect(outcome.changedCount).toBe(0);
    expect(outcome.codeVersionChanged).toBe(false);
    expect(outcome.dataVersionChanged).toBe(false);
    expect(outcome.diffs.length).toBe(first.results.length);
    // 复现使用新 runId，原始记录不被覆盖。
    expect(outcome.replayRun.runId).toBe(`${first.run.runId}-replay-test`);
    expect((await store.getRun(first.run.runId))?.runId).toBe(first.run.runId);
  });

  it('批次不存在时抛出可读错误', async () => {
    await expect(replayMiningRun('missing', {
      store,
      prepareData: async () => historicalFixture(),
    })).rejects.toThrow(/挖掘记录不存在/);
  });
});

describe('挖掘流水线的滑点校准注入', () => {
  let root = '';
  let store: MiningStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mining-cal-inject-'));
    store = new MiningStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fixture = historicalFixture();

  it('存在实测校准时滑点被写入回测参数并在报告中记录', async () => {
    await store.saveCalibration({
      runId: 'run-prev',
      createdAt: '2026-01-01 00:00:00',
      slippageRate: 0.012,
      unfilledRate: 0.05,
      cancelRate: 0.01,
      sampleSize: 20,
    });

    const outcome = await runMiningPipeline({
      universe: ['600001', '000002', '300003', '600004'],
      strategies: ['ma-trend'],
      days: 60,
      grid: { dimensions: { maxHoldDays: [3, 5] } },
      walkforward: { windowSize: 40, stepSize: 20, minTradeCount: 1 },
      thresholds: { minPriceCoverage: 0.8, minLimitUpCoverage: 0, requireAdjusted: true },
      store,
      codeVersion: 'abc123',
      prepareData: async () => fixture,
    });

    expect((outcome.run.config.baseParams as { slippageRate?: number }).slippageRate).toBe(0.012);
    expect(outcome.report.calibration?.runId).toBe('run-prev');
    expect(outcome.results[0].outOfSampleDays).toBeGreaterThan(0);
  });

  it('没有校准数据时沿用默认滑点', async () => {
    const outcome = await runMiningPipeline({
      universe: ['600001', '000002', '300003', '600004'],
      strategies: ['ma-trend'],
      days: 60,
      grid: { dimensions: { maxHoldDays: [3, 5] } },
      walkforward: { windowSize: 40, stepSize: 20, minTradeCount: 1 },
      thresholds: { minPriceCoverage: 0.8, minLimitUpCoverage: 0, requireAdjusted: true },
      store,
      codeVersion: 'abc123',
      prepareData: async () => fixture,
    });

    expect((outcome.run.config.baseParams as { slippageRate?: number }).slippageRate).toBeUndefined();
    expect(outcome.report.calibration).toBeUndefined();
  });
});
