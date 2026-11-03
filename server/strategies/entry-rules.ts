/**
 * 买入信号的硬性规则（所有买入路径共享）。
 *
 * 单独成文件是为了避免 `trading-strategy.ts` 与 `strategies/registry.ts` 互相 import
 * 形成循环依赖；`trading-strategy.ts` 会重新导出这里的函数，保持既有对外 API 不变。
 */

/**
 * 买入信号的多头排列校验（所有买入路径的唯一口径）。
 *
 *   收盘价 > MA3 > MA5 > MA20
 *
 * 即价格站在 MA3 之上、且短中周期均线依次上抬；不满足该排列的买入信号一律排除。
 * 任一均线缺失（例如旧排行快照没有 ma5/ma20）时无法确认排列，按不通过处理。
 */
export function passesMaAlignmentEntryRule(
  signalPrice: number | null | undefined,
  ma3: number | null | undefined,
  ma5: number | null | undefined,
  ma20: number | null | undefined,
): boolean {
  const price = Number(signalPrice);
  const ma3Value = Number(ma3);
  const ma5Value = Number(ma5);
  const ma20Value = Number(ma20);
  if (![price, ma3Value, ma5Value, ma20Value].every(Number.isFinite)) return false;
  if (price <= 0 || ma3Value <= 0 || ma5Value <= 0 || ma20Value <= 0) return false;
  return price > ma3Value && ma3Value > ma5Value && ma5Value > ma20Value;
}
