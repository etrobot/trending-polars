/**
 * 买入信号子策略注册机制（P2）。
 *
 * 设计原则（改动前请先读这里）：
 * 1. **单一入口不变**：所有买入路径仍然只调用 `rankEntryCandidates`，禁止旁路。
 *    子策略只在这一个函数内部被遍历调用。
 * 2. **子策略纯函数化**：`evaluate(ctx)` 输入行情/指标快照，输出候选打分，无副作用。
 * 3. **板块因子解耦**：881 行业板块轮动评分作为可选的加权层接入，不进子策略内部，
 *    关闭时不影响排序结果。
 * 4. **异常隔离**：单个子策略抛错不得中断整体信号生成，记录错误后继续。
 *
 * 分数合成规则（多策略命中同一只股票时）：
 * - `max`（默认）：取各命中策略分数的最大值。理由：分数本身是「绝对质量分」，
 *   取最大值等价于「最强的那个策略认可这只股票」。
 * - `weighted`：按策略权重加权平均，权重之和归一化到 1。
 */

import type { RankingRow } from '../../src/types.js';
import { passesMaAlignmentEntryRule } from './entry-rules.js';

/** 板块轮动加权层输入。 */
export interface SectorRotationWeighting {
  /** 股票代码 → 所属板块代码。 */
  sectorCodeByStock?: ReadonlyMap<string, string>;
  /** 板块代码 → 轮动评分（0-100，越高越强势）。 */
  sectorScoreBySector?: ReadonlyMap<string, number>;
  /** 加权强度（百分点）：板块分每高于中性 50 分，个股总分加/减 weightPct。 */
  weightPct?: number;
}

export interface StrategyContext {
  /** 当日截面排行快照。 */
  rows: readonly RankingRow[];
  /** 已排除的股票代码（持仓、涨停等）。 */
  excludedCodes: ReadonlySet<string>;
  /** 入场总分下限（100 分制）。 */
  minEntryScore: number;
  /** 板块轮动加权层，可为空（关闭）。 */
  sectorRotation?: SectorRotationWeighting | null;
}

export interface EntryCandidate {
  code: string;
  /** 0-100 打分。 */
  score: number;
  strategyId: string;
  /** 命中条件说明，用于审计与前端展示。 */
  reasons: string[];
}

export interface EntrySubStrategy {
  id: string;
  name: string;
  /** 策略权重，仅 `weighted` 合成规则下生效。 */
  weight?: number;
  evaluate(ctx: StrategyContext): EntryCandidate[];
}

/** 分数合成规则。 */
export type ScoreMergeRule = 'max' | 'weighted';

export interface MergeOptions {
  rule: ScoreMergeRule;
}

const registry = new Map<string, EntrySubStrategy>();

/** 注册（或覆盖）一个子策略。 */
export function registerStrategy(strategy: EntrySubStrategy): void {
  registry.set(strategy.id, strategy);
}

/** 列出全部已注册子策略。 */
export function listStrategies(): EntrySubStrategy[] {
  return [...registry.values()];
}

/** 读取单个子策略。 */
export function getStrategy(id: string): EntrySubStrategy | undefined {
  return registry.get(id);
}

/** 清空注册表（测试用）。 */
export function clearStrategies(): void {
  registry.clear();
}

/**
 * 从环境变量读取启用的策略列表。
 *
 * 变量名 `ENTRY_STRATEGIES`，逗号分隔；未配置时仅启用 `ma-trend`，
 * 保证未配置时行为与改动前完全一致。
 */
export function enabledStrategyIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ENTRY_STRATEGIES?.trim();
  if (!raw) return ['ma-trend'];
  const ids = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return ids.length ? ids : ['ma-trend'];
}

/** 按启用列表取出子策略对象；已注册但未启用的不参与计算。 */
export function resolveStrategies(ids: readonly string[]): EntrySubStrategy[] {
  const resolved: EntrySubStrategy[] = [];
  for (const id of ids) {
    const strategy = registry.get(id);
    if (strategy) resolved.push(strategy);
  }
  return resolved;
}

/**
 * 合并同一只股票被多个策略命中的候选。
 *
 * @param candidates 各策略产出的候选（可能重复 code）
 * @param rule 合成规则
 * @param weightByStrategyId 策略权重表，`weighted` 规则下生效；缺省视为 1
 */
export function mergeCandidates(
  candidates: readonly EntryCandidate[],
  rule: ScoreMergeRule = 'max',
  weightByStrategyId?: ReadonlyMap<string, number>,
): Map<string, EntryCandidate> {
  // 内部按 code 聚合各策略的独立贡献，weighted 规则需要逐策略的分数与权重。
  const buckets = new Map<string, { contributions: EntryCandidate[]; reasons: string[] }>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.code);
    if (!bucket) {
      buckets.set(candidate.code, { contributions: [candidate], reasons: [...candidate.reasons] });
      continue;
    }
    bucket.contributions.push(candidate);
    bucket.reasons.push(...candidate.reasons);
  }

  const merged = new Map<string, EntryCandidate>();
  for (const [code, bucket] of buckets) {
    const strategyIds = [...new Set(bucket.contributions.map((item) => item.strategyId))];
    let score: number;
    if (rule === 'max') {
      score = Math.max(...bucket.contributions.map((item) => item.score));
    } else {
      let weightedSum = 0;
      let totalWeight = 0;
      for (const item of bucket.contributions) {
        const weight = weightByStrategyId?.get(item.strategyId) ?? 1;
        weightedSum += item.score * weight;
        totalWeight += weight;
      }
      score = totalWeight > 0
        ? weightedSum / totalWeight
        : Math.max(...bucket.contributions.map((item) => item.score));
    }
    merged.set(code, {
      code,
      score,
      strategyId: strategyIds.join('+'),
      reasons: bucket.reasons,
    });
  }
  return merged;
}

/**
 * 板块轮动加权（可选层）。
 *
 * 未配置 `sectorRotation` 或缺少映射时原样返回，不影响排序结果。
 */
export function applySectorRotationWeight(
  candidates: readonly EntryCandidate[],
  rowByCode: ReadonlyMap<string, RankingRow>,
  weighting?: SectorRotationWeighting | null,
): EntryCandidate[] {
  if (!weighting?.sectorCodeByStock || !weighting.sectorScoreBySector) {
    return [...candidates];
  }
  const weightPct = weighting.weightPct ?? 0;
  if (!weightPct) return [...candidates];
  return candidates.map((candidate) => {
    const row = rowByCode.get(candidate.code);
    const sectorCode = weighting.sectorCodeByStock?.get(candidate.code)
      ?? (row?.sector_code ? String(row.sector_code) : undefined);
    if (!sectorCode) return candidate;
    const sectorScore = weighting.sectorScoreBySector?.get(sectorCode);
    if (sectorScore == null || !Number.isFinite(sectorScore)) return candidate;
    const adjusted = candidate.score + (sectorScore - 50) / 50 * weightPct;
    return {
      ...candidate,
      score: Math.max(0, Math.min(100, adjusted)),
      reasons: [...candidate.reasons, `板块轮动加权 ${sectorScore.toFixed(1)}`],
    };
  });
}

/**
 * 板块轮动加权强度（百分点）。
 *
 * 环境变量 `SECTOR_ROTATION_WEIGHT_PCT`；未配置或为 0 时关闭该层，
 * 此时排序结果与关闭前完全一致。
 */
export function enabledSectorRotationWeightPct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SECTOR_ROTATION_WEIGHT_PCT?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(50, value);
}

/**
 * 从截面排行快照里直接构造板块轮动加权层。
 *
 * 依赖行上的 `sector_code`（881 行业板块代码）与 `sector_rotation_score`
 * （板块轮动评分 0-100）。缺任一字段的股票不参与加权。
 */
export function sectorRotationWeightingFromRows(
  rows: readonly RankingRow[],
  weightPct: number,
): SectorRotationWeighting | null {
  if (!weightPct) return null;
  const sectorCodeByStock = new Map<string, string>();
  const sectorScoreBySector = new Map<string, number>();
  for (const row of rows) {
    const code = String(row.stock_code ?? '');
    const sectorCode = String(row.sector_code ?? '').trim();
    if (!code || !sectorCode) continue;
    sectorCodeByStock.set(code, sectorCode);
    const score = Number((row as RankingRow & { sector_rotation_score?: number }).sector_rotation_score);
    if (Number.isFinite(score) && score > 0 && !sectorScoreBySector.has(sectorCode)) {
      sectorScoreBySector.set(sectorCode, score);
    }
  }
  if (!sectorScoreBySector.size) return null;
  return { sectorCodeByStock, sectorScoreBySector, weightPct };
}

// ---------------------------------------------------------------------------
// 内置子策略
// ---------------------------------------------------------------------------

/**
 * `ma-trend`：多头排列买入信号（现有规则的直接封装）。
 *
 * 判定：收盘价 > MA3 > MA5 > MA20。
 * 得分直接沿用截面的 `total_score`，与改动前 rankEntryCandidates 的排序口径完全一致。
 */
export const maTrendStrategy: EntrySubStrategy = {
  id: 'ma-trend',
  name: '多头排列',
  weight: 1,
  evaluate(ctx: StrategyContext): EntryCandidate[] {
    const candidates: EntryCandidate[] = [];
    for (const row of ctx.rows) {
      const code = String(row.stock_code ?? '');
      if (!code || ctx.excludedCodes.has(code)) continue;
      if (!passesMaAlignmentEntryRule(row.latest_price, row.ma3, row.ma5, row.ma20)) continue;
      candidates.push({
        code,
        score: Number(row.total_score ?? 0),
        strategyId: 'ma-trend',
        reasons: ['收盘 > MA3 > MA5 > MA20 多头排列'],
      });
    }
    return candidates;
  },
};

/**
 * `breakout-20d`：20 日新高突破（示例子策略）。
 *
 * 判定：最新价 >= 20 日最高价，且当日涨幅为正。
 * 依赖 `RankingRow.high_20d` 字段；该字段缺失时该策略不产生任何候选，
 * 因此在旧行情快照上接入也不会误触发。
 */
export const breakout20dStrategy: EntrySubStrategy = {
  id: 'breakout-20d',
  name: '20日新高突破',
  weight: 1,
  evaluate(ctx: StrategyContext): EntryCandidate[] {
    const candidates: EntryCandidate[] = [];
    for (const row of ctx.rows) {
      const code = String(row.stock_code ?? '');
      if (!code || ctx.excludedCodes.has(code)) continue;
      const high20d = Number((row as RankingRow & { high_20d?: number | null }).high_20d);
      const price = Number(row.latest_price);
      const changeRate = Number(row.latest_change_rate);
      if (!Number.isFinite(high20d) || high20d <= 0) continue;
      if (!Number.isFinite(price) || price < high20d) continue;
      if (!Number.isFinite(changeRate) || changeRate <= 0) continue;
      const score = Math.max(0, Math.min(100, 60 + Math.min(changeRate, 10) * 4));
      candidates.push({
        code,
        score,
        strategyId: 'breakout-20d',
        reasons: [`突破20日新高 ${high20d.toFixed(2)}，当日涨幅 ${changeRate.toFixed(2)}%`],
      });
    }
    return candidates;
  },
};

/** 注册内置子策略。 */
export function registerBuiltinStrategies(): void {
  registerStrategy(maTrendStrategy);
  registerStrategy(breakout20dStrategy);
}

// 模块加载时注册内置策略，保证任何调用方 import 后即可直接使用。
registerBuiltinStrategies();
