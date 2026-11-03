import pl from 'nodejs-polars';
import type { RankingRow } from '../src/types.js';
import { round } from './format.js';
import { positionRatioForScore } from './scoring-engine.js';
import {
  applySectorRotationWeight,
  enabledSectorRotationWeightPct,
  enabledStrategyIds,
  mergeCandidates,
  resolveStrategies,
  sectorRotationWeightingFromRows,
  type EntryCandidate,
  type EntrySubStrategy,
  type StrategyContext,
} from './strategies/registry.js';

export interface T1StrategyConfig {
  maxHoldDays: number;
  maxPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxEntriesPerDay: number;
  positionSizePct: number;
  maxCandidates: number;
  /**
   * 入场总分下限（100 分制）。
   * 只有在 applyFactorWeights 做了归一化之后这个绝对阈值才成立 —— 否则调低任一因子权重
   * 都会连带抬高实际入场门槛，权重优化会同时改变「因子相对影响」与「入场松紧」两件事。
   */
  minEntryScore: number;
  /**
   * 是否按个股总分缩放仓位（positionRatioForScore：≥70 → 0.8 / ≥55 → 0.6 / …）。
   *
   * 这条链路过去是断的：`positionRatioForScore` / `strategyForScore` 只被测试引用，
   * 实际下单一律用固定的 positionSizePct，所有入选股票仓位相同 —— 而 docs/logic.md §2.3
   * 用一整张表描述了分档仓位。打开后评分才真正影响「买多少」，而不只是「买不买」。
   */
  scoreScaledSizing: boolean;
  lotSize: number;
  slippageRate: number;
  commissionRate: number;
  minimumCommission: number;
  stampTaxRate: number;
}

export const DEFAULT_T1_STRATEGY: Readonly<T1StrategyConfig> = Object.freeze({
  maxHoldDays: 5,
  maxPositions: 10,
  stopLossPct: -5,
  takeProfitPct: 15,
  maxEntriesPerDay: 2,
  positionSizePct: 10,
  maxCandidates: 5,
  minEntryScore: 40,
  scoreScaledSizing: true,
  lotSize: 100,
  slippageRate: 0.0005,
  commissionRate: 0.0003,
  minimumCommission: 5,
  stampTaxRate: 0.0005,
});

export function createT1StrategyConfig(overrides: Partial<T1StrategyConfig> = {}): T1StrategyConfig {
  return {
    ...DEFAULT_T1_STRATEGY,
    ...overrides,
    maxHoldDays: Math.max(1, Math.trunc(overrides.maxHoldDays ?? DEFAULT_T1_STRATEGY.maxHoldDays)),
    maxPositions: Math.max(1, Math.trunc(overrides.maxPositions ?? DEFAULT_T1_STRATEGY.maxPositions)),
  };
}

export function strategyFromBacktestConfig(
  config: Record<string, number | string | null | undefined>,
): Partial<T1StrategyConfig> {
  const overrides: Partial<T1StrategyConfig> = {};
  const maxHoldDays = Number(config.max_hold_days);
  const maxPositions = Number(config.max_positions);
  const positionSizePct = Number(config.position_size_pct);
  const takeProfitPct = Number(config.take_profit_pct);
  const stopLossRaw = Number(config.stop_loss_pct);
  const maxEntriesPerDay = Number(config.max_positions_per_day);

  if (Number.isFinite(maxHoldDays) && maxHoldDays > 0) overrides.maxHoldDays = Math.trunc(maxHoldDays);
  if (Number.isFinite(maxPositions) && maxPositions > 0) overrides.maxPositions = Math.trunc(maxPositions);
  if (Number.isFinite(positionSizePct) && positionSizePct > 0) overrides.positionSizePct = Math.trunc(positionSizePct);
  if (Number.isFinite(takeProfitPct) && takeProfitPct > 0) overrides.takeProfitPct = Math.trunc(takeProfitPct);
  if (Number.isFinite(stopLossRaw) && stopLossRaw !== 0) {
    overrides.stopLossPct = stopLossRaw > 0 ? -Math.abs(Math.trunc(stopLossRaw)) : Math.trunc(stopLossRaw);
  }
  if (Number.isFinite(maxEntriesPerDay) && maxEntriesPerDay > 0) overrides.maxEntriesPerDay = Math.trunc(maxEntriesPerDay);
  return overrides;
}

/**
 * 挖掘参数（camelCase，来自 P4 的 MiningResult.params）→ T1StrategyConfig 覆盖项。
 *
 * 与 `strategyFromBacktestConfig` 并列：后者吃回测库里的 snake_case 配置，
 * 这里吃挖掘流水线产出的候选参数。未知键与非有限值一律忽略。
 */
export function miningParamsToStrategyConfig(
  params: Record<string, number>,
): Partial<T1StrategyConfig> {
  const overrides: Partial<T1StrategyConfig> = {};
  const maxHoldDays = Number(params.maxHoldDays);
  const maxPositions = Number(params.maxPositions);
  const positionSizePct = Number(params.positionSizePct);
  const takeProfitPct = Number(params.takeProfitPct);
  const stopLossRaw = Number(params.stopLossPct);
  const minEntryScore = Number(params.minEntryScore);
  const maxCandidates = Number(params.maxCandidates);
  const maxEntriesPerDay = Number(params.maxEntriesPerDay);

  if (Number.isFinite(maxHoldDays) && maxHoldDays > 0) overrides.maxHoldDays = Math.trunc(maxHoldDays);
  if (Number.isFinite(maxPositions) && maxPositions > 0) overrides.maxPositions = Math.trunc(maxPositions);
  if (Number.isFinite(positionSizePct) && positionSizePct > 0) overrides.positionSizePct = Math.trunc(positionSizePct);
  if (Number.isFinite(takeProfitPct) && takeProfitPct > 0) overrides.takeProfitPct = Math.trunc(takeProfitPct);
  if (Number.isFinite(stopLossRaw) && stopLossRaw !== 0) {
    overrides.stopLossPct = stopLossRaw > 0 ? -Math.abs(Math.trunc(stopLossRaw)) : Math.trunc(stopLossRaw);
  }
  if (Number.isFinite(minEntryScore) && minEntryScore >= 0) overrides.minEntryScore = Math.trunc(minEntryScore);
  if (Number.isFinite(maxCandidates) && maxCandidates > 0) overrides.maxCandidates = Math.trunc(maxCandidates);
  if (Number.isFinite(maxEntriesPerDay) && maxEntriesPerDay > 0) overrides.maxEntriesPerDay = Math.trunc(maxEntriesPerDay);
  return overrides;
}

export function serializeStrategyConfig(config: T1StrategyConfig) {
  return {
    maxHoldDays: config.maxHoldDays,
    maxPositions: config.maxPositions,
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    maxEntriesPerDay: config.maxEntriesPerDay,
    positionSizePct: config.positionSizePct,
    maxCandidates: config.maxCandidates,
  };
}

/**
 * 买入信号的多头排列校验（所有买入路径的唯一口径）。
 *
 *   收盘价 > MA3 > MA5 > MA20
 *
 * 实现位于 strategies/entry-rules.ts，这里重新导出以保持既有对外 API 不变。
 */
export { passesMaAlignmentEntryRule } from './strategies/entry-rules.js';

/** rankEntryCandidates 的可选扩展参数。 */
export interface EntryCandidateOptions {
  /** 启用的子策略 id 列表；缺省读取环境变量（默认仅 ma-trend）。 */
  strategyIds?: string[];
  /** 分数合成规则，默认 max。 */
  scoreMergeRule?: 'max' | 'weighted';
  /** 板块轮动加权层，缺省关闭。 */
  sectorRotation?: import('./strategies/registry.js').SectorRotationWeighting | null;
}

/**
 * 买入信号生成的**唯一入口**（所有回测 / 参数优化 / 模拟交易路径都必须经过这里）。
 *
 * 内部流程（P2 子策略注册机制）：
 * 1. 遍历启用的子策略收集候选（单策略异常隔离，不影响整体信号生成）；
 * 2. 合并去重（同股多策略命中时按配置规则合成分数）；
 * 3. 应用全局硬过滤（入场总分下限）；
 * 4. 应用可选的板块轮动加权（关闭时不影响排序结果）；
 * 5. 按分数排序输出前 N。
 *
 * 未配置 `ENTRY_STRATEGIES` 时仅启用 `ma-trend`，其判定与得分完全沿用改动前口径，
 * 因此输出与改动前逐条一致。
 */
export function rankEntryCandidates(
  rows: RankingRow[],
  excludedCodes: ReadonlySet<string> = new Set(),
  limit = DEFAULT_T1_STRATEGY.maxCandidates,
  minEntryScore = DEFAULT_T1_STRATEGY.minEntryScore,
  options: EntryCandidateOptions = {},
): RankingRow[] {
  const strategyIds = options.strategyIds ?? enabledStrategyIds();
  const strategies = resolveStrategies(strategyIds);
  if (!strategies.length) return [];

  const ctx: StrategyContext = {
    rows,
    excludedCodes,
    minEntryScore,
    sectorRotation: options.sectorRotation ?? null,
  };

  const collected: EntryCandidate[] = [];
  for (const strategy of strategies) {
    try {
      collected.push(...strategy.evaluate(ctx));
    } catch (error) {
      // 异常隔离：单个子策略失败不影响其余策略的信号产出。
      console.error(`[rankEntryCandidates] 子策略 ${strategy.id} 执行失败，已跳过`, error);
    }
  }
  if (!collected.length) return [];

  const merged = mergeCandidates(collected, options.scoreMergeRule ?? 'max', weightMap(strategies));
  const rowByCode = new Map<string, RankingRow>();
  for (const row of rows) {
    const code = String(row.stock_code ?? '');
    if (code && !rowByCode.has(code)) rowByCode.set(code, row);
  }

  // 流程顺序：合并去重 → 板块轮动加权 → 全局硬过滤（入场总分下限）→ 排序输出。
  // 板块轮动加权是可选层：未显式传入时按环境变量开关推导，关闭时不影响排序结果。
  const sectorRotation = options.sectorRotation
    ?? sectorRotationWeightingFromRows(rows, enabledSectorRotationWeightPct());
  const weighted = applySectorRotationWeight([...merged.values()], rowByCode, sectorRotation);
  const eligible = weighted.filter((candidate) => candidate.score >= minEntryScore);
  if (!eligible.length) return [];
  // 排序在 Polars 侧完成，且保持与改动前完全一致的帧结构与排序语义
  // （同分股票的相对次序因此也与改动前一致）。命中原因在排序后按代码回填，
  // 避免把字符串数组塞进 DataFrame 列。
  const frameRows = eligible.map((candidate) => {
    const row = rowByCode.get(candidate.code);
    return {
      ...(row ?? {}),
      stock_code: candidate.code,
      total_score: Number(candidate.score),
    };
  });
  const selected = pl.DataFrame(frameRows)
    .sort('total_score', true, true)
    .head(Math.max(0, Math.trunc(limit)))
    .toRecords() as unknown as RankingRow[];

  const candidateByCode = new Map(weighted.map((candidate) => [candidate.code, candidate]));
  return selected.map((row) => {
    const candidate = candidateByCode.get(String(row.stock_code ?? ''));
    return {
      ...row,
      entry_strategy_id: candidate?.strategyId ?? '',
      entry_reasons: candidate?.reasons ?? [],
    } as RankingRow;
  });
}

function weightMap(strategies: readonly EntrySubStrategy[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const strategy of strategies) weights.set(strategy.id, strategy.weight ?? 1);
  return weights;
}

export function commission(grossAmount: number, config: T1StrategyConfig = DEFAULT_T1_STRATEGY): number {
  return round(Math.max(config.minimumCommission, grossAmount * config.commissionRate), 2);
}

/**
 * 计算建仓股数。
 *
 * `totalScore` 传入时（且 config.scoreScaledSizing 为真），单票额度会按
 * positionRatioForScore 的分档系数缩放 —— 高分股票拿更大仓位，这是 docs/logic.md §2.3
 * 描述、但过去从未真正生效的行为。不传则退回固定额度。
 */
export function calculateEntrySize(
  cash: number,
  referenceCapital: number,
  price: number,
  config: T1StrategyConfig = DEFAULT_T1_STRATEGY,
  totalScore?: number,
): { shares: number; grossAmount: number; totalCost: number } | null {
  if (cash <= 0 || referenceCapital <= 0 || price <= 0) return null;
  const scoreRatio = config.scoreScaledSizing && totalScore != null
    ? positionRatioForScore(totalScore)
    : 1;
  if (scoreRatio <= 0) return null;
  const sizePct = config.positionSizePct * scoreRatio;
  const allocation = Math.min(
    cash * sizePct / 100,
    referenceCapital * sizePct / 100,
  );
  let shares = Math.floor(allocation / price / config.lotSize) * config.lotSize;
  while (shares >= config.lotSize) {
    const grossAmount = round(shares * price, 2);
    const totalCost = round(grossAmount + commission(grossAmount, config), 2);
    if (totalCost <= cash) return { shares, grossAmount, totalCost };
    shares -= config.lotSize;
  }
  return null;
}

export function exitSignalReason(
  pnlPct: number,
  holdDays: number,
  config: T1StrategyConfig = DEFAULT_T1_STRATEGY,
): string | null {
  if (pnlPct <= config.stopLossPct) return `止损信号 ${round(pnlPct, 2)}%`;
  if (pnlPct >= config.takeProfitPct) return `止盈信号 +${round(pnlPct, 2)}%`;
  if (holdDays >= config.maxHoldDays) return `持仓满 ${holdDays} 日`;
  return null;
}

export function tradingDayDistance(fromDate: string, toDate: string, calendar: readonly string[]): number {
  const normalizedFrom = fromDate.replaceAll('-', '').slice(0, 8);
  const normalizedTo = toDate.replaceAll('-', '').slice(0, 8);
  const fromIndex = calendar.indexOf(normalizedFrom);
  const toIndex = calendar.indexOf(normalizedTo);
  if (fromIndex >= 0 && toIndex >= fromIndex) return toIndex - fromIndex;

  const cursor = new Date(`${normalizedFrom.slice(0, 4)}-${normalizedFrom.slice(4, 6)}-${normalizedFrom.slice(6, 8)}T12:00:00+08:00`);
  const target = new Date(`${normalizedTo.slice(0, 4)}-${normalizedTo.slice(4, 6)}-${normalizedTo.slice(6, 8)}T12:00:00+08:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(target.getTime()) || cursor > target) return 0;
  let days = 0;
  while (cursor < target) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}
