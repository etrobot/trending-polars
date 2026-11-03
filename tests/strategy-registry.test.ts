import { describe, expect, it, beforeEach } from 'vitest';
import {
  applySectorRotationWeight,
  clearStrategies,
  enabledSectorRotationWeightPct,
  enabledStrategyIds,
  getStrategy,
  listStrategies,
  mergeCandidates,
  registerStrategy,
  registerBuiltinStrategies,
  resolveStrategies,
  sectorRotationWeightingFromRows,
  type EntryCandidate,
} from '../server/strategies/registry.js';
import { rankEntryCandidates } from '../server/trading-strategy.js';
import type { RankingRow } from '../src/types.js';

function row(overrides: Partial<RankingRow> & { stock_code: string }): RankingRow {
  return {
    rank: 1,
    stock_name: overrides.stock_code,
    total_score: 50,
    alignment: '多头排列',
    ...overrides,
  } as RankingRow;
}

/** 构造满足「收盘 > MA3 > MA5 > MA20」的排行行。 */
function maRow(code: string, score: number, overrides: Partial<RankingRow> = {}): RankingRow {
  return row({
    stock_code: code,
    total_score: score,
    latest_price: 20,
    ma3: 18,
    ma5: 16,
    ma20: 14,
    ...overrides,
  });
}

describe('子策略注册机制', () => {
  beforeEach(() => {
    clearStrategies();
    registerBuiltinStrategies();
  });

  it('内置策略已注册且可读取', () => {
    expect(listStrategies().map((item) => item.id).sort()).toEqual(['breakout-20d', 'ma-trend']);
    expect(getStrategy('ma-trend')?.name).toBe('多头排列');
  });

  it('未配置 ENTRY_STRATEGIES 时仅启用 ma-trend', () => {
    expect(enabledStrategyIds({} as NodeJS.ProcessEnv)).toEqual(['ma-trend']);
    expect(enabledStrategyIds({ ENTRY_STRATEGIES: 'ma-trend,breakout-20d' } as NodeJS.ProcessEnv))
      .toEqual(['ma-trend', 'breakout-20d']);
    expect(resolveStrategies(['ma-trend']).map((item) => item.id)).toEqual(['ma-trend']);
  });

  it('max 规则取各策略最高分，weighted 规则按权重加权平均', () => {
    const candidates: EntryCandidate[] = [
      { code: '600001', score: 60, strategyId: 'ma-trend', reasons: ['a'] },
      { code: '600001', score: 90, strategyId: 'breakout-20d', reasons: ['b'] },
    ];
    const max = mergeCandidates(candidates, 'max').get('600001')!;
    expect(max.score).toBe(90);
    expect(max.strategyId).toBe('ma-trend+breakout-20d');
    expect(max.reasons).toEqual(['a', 'b']);

    const weighted = mergeCandidates(candidates, 'weighted', new Map([['ma-trend', 1], ['breakout-20d', 3]])).get('600001')!;
    expect(weighted.score).toBeCloseTo((60 * 1 + 90 * 3) / 4, 6);
  });

  it('单个子策略抛错不影响整体信号生成', () => {
    registerStrategy({
      id: 'boom',
      name: '会抛错的策略',
      evaluate() {
        throw new Error('boom');
      },
    });
    const rows = [maRow('600001', 70)];
    const result = rankEntryCandidates(rows, new Set(), 5, 40, { strategyIds: ['boom', 'ma-trend'] });
    expect(result.map((item) => item.stock_code)).toEqual(['600001']);
  });

  it('新注册的子策略无需改动 rankEntryCandidates 调用方即可接入', () => {
    registerStrategy({
      id: 'high-score-80',
      name: '总分80以上',
      evaluate(ctx) {
        return ctx.rows
          .filter((item) => Number(item.total_score) >= 80)
          .map((item) => ({
            code: String(item.stock_code),
            score: Number(item.total_score),
            strategyId: 'high-score-80',
            reasons: ['总分不低于 80'],
          }));
      },
    });
    const rows = [maRow('600001', 70), maRow('600002', 85)];
    const result = rankEntryCandidates(rows, new Set(), 5, 40, { strategyIds: ['high-score-80'] });
    expect(result.map((item) => item.stock_code)).toEqual(['600002']);
    expect(result[0].entry_strategy_id).toBe('high-score-80');
    expect(result[0].entry_reasons).toContain('总分不低于 80');
  });
});

describe('板块轮动加权层', () => {
  it('关闭时不影响排序结果', () => {
    const candidates: EntryCandidate[] = [
      { code: '600001', score: 60, strategyId: 'ma-trend', reasons: [] },
      { code: '600002', score: 70, strategyId: 'ma-trend', reasons: [] },
    ];
    const rowByCode = new Map<string, RankingRow>([
      ['600001', maRow('600001', 60, { sector_code: '881001' })],
      ['600002', maRow('600002', 70, { sector_code: '881002' })],
    ]);
    const off = applySectorRotationWeight(candidates, rowByCode, null);
    expect(off.map((item) => item.score)).toEqual([60, 70]);

    const zeroWeight = applySectorRotationWeight(candidates, rowByCode, {
      sectorCodeByStock: new Map([['600001', '881001']]),
      sectorScoreBySector: new Map([['881001', 90]]),
      weightPct: 0,
    });
    expect(zeroWeight.map((item) => item.score)).toEqual([60, 70]);
  });

  it('开启时按板块分相对中性值调整个股总分并记录原因', () => {
    const candidates: EntryCandidate[] = [
      { code: '600001', score: 60, strategyId: 'ma-trend', reasons: ['原原因'] },
    ];
    const rowByCode = new Map<string, RankingRow>([
      ['600001', maRow('600001', 60, { sector_code: '881001' })],
    ]);
    const weighted = applySectorRotationWeight(candidates, rowByCode, {
      sectorCodeByStock: new Map([['600001', '881001']]),
      sectorScoreBySector: new Map([['881001', 75]]),
      weightPct: 10,
    });
    expect(weighted[0].score).toBeCloseTo(65, 6);
    expect(weighted[0].reasons).toContain('板块轮动加权 75.0');
  });

  it('加权强度由环境变量控制，未配置时为 0', () => {
    expect(enabledSectorRotationWeightPct({} as NodeJS.ProcessEnv)).toBe(0);
    expect(enabledSectorRotationWeightPct({ SECTOR_ROTATION_WEIGHT_PCT: '8' } as NodeJS.ProcessEnv)).toBe(8);
    expect(enabledSectorRotationWeightPct({ SECTOR_ROTATION_WEIGHT_PCT: '-3' } as NodeJS.ProcessEnv)).toBe(0);
  });

  it('从排行快照构造加权层时只认带板块评分的行', () => {
    const rows = [
      maRow('600001', 60, { sector_code: '881001', sector_rotation_score: 80 }),
      maRow('600002', 61, { sector_code: '881002' }),
    ];
    const weighting = sectorRotationWeightingFromRows(rows, 10)!;
    expect(weighting.sectorCodeByStock!.get('600001')).toBe('881001');
    expect(weighting.sectorScoreBySector!.has('881002')).toBe(false);
    expect(sectorRotationWeightingFromRows(rows, 0)).toBeNull();
  });
});

describe('rankEntryCandidates 回归', () => {
  beforeEach(() => {
    clearStrategies();
    registerBuiltinStrategies();
  });

  it('仅启用 ma-trend 时输出与多头排列规则逐条一致', () => {
    const rows = [
      maRow('600001', 70),
      maRow('600002', 65),
      // 不满足多头排列：收盘价低于 MA3。
      row({ stock_code: '600003', total_score: 90, latest_price: 10, ma3: 12, ma5: 9, ma20: 8 }),
      maRow('600004', 30),
    ];
    const result = rankEntryCandidates(rows, new Set(), 10, 40);
    expect(result.map((item) => item.stock_code)).toEqual(['600001', '600002']);
    expect(result.map((item) => item.total_score)).toEqual([70, 65]);
    expect(result[0].entry_strategy_id).toBe('ma-trend');
    expect(result[0].entry_reasons).toContain('收盘 > MA3 > MA5 > MA20 多头排列');
  });

  it('入场总分下限是硬过滤，且排除已持仓股票', () => {
    const rows = [maRow('600001', 70), maRow('600002', 45), maRow('600003', 30)];
    const result = rankEntryCandidates(rows, new Set(['600001']), 10, 40);
    // 600001 被排除，600003 低于入场总分下限。
    expect(result.map((item) => item.stock_code)).toEqual(['600002']);
  });

  it('limit 生效并按总分降序', () => {
    const rows = [maRow('600001', 50), maRow('600002', 80), maRow('600003', 65)];
    const result = rankEntryCandidates(rows, new Set(), 2, 40);
    expect(result.map((item) => item.stock_code)).toEqual(['600002', '600003']);
  });
});
