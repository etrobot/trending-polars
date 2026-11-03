/**
 * 挖掘报告渲染（P4）。
 *
 * 输出自包含 HTML（无外部依赖），便于直接归档或分享；
 * 同一份数据同时生成 JSON 报告（由 MiningStore 落库）。
 */

import { round } from '../format.js';
import type { MiningReport, MiningResult } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function metricCell(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function resultRow(result: MiningResult, bestParams: Record<string, number>): string {
  const paramCells = Object.keys(bestParams)
    .map((key) => {
      const value = result.params[key];
      const isBest = bestParams[key] === value;
      const text = value === undefined ? '—' : String(value);
      return `<td class="${isBest ? 'best' : ''}">${escapeHtml(text)}</td>`;
    })
    .join('');
  return `<tr class="${result.unstable ? 'unstable' : ''}">
    <td>${result.rank}</td>
    ${paramCells}
    <td>${metricCell(result.outOfSample.annualReturn)}</td>
    <td>${metricCell(result.outOfSample.maxDrawdown)}</td>
    <td>${metricCell(result.outOfSample.sharpe, 4)}</td>
    <td>${metricCell(result.outOfSample.winRate, 1)}</td>
    <td>${metricCell(result.outOfSample.profitFactor, 3)}</td>
    <td>${result.tradeCount}</td>
    <td>${metricCell(result.stabilityScore, 4)}</td>
    <td>${metricCell(result.inSample.sharpe, 4)}</td>
    <td>${result.unstable ? '悬崖' : '稳定'}</td>
  </tr>`;
}

/**
 * 生成 HTML 报告。
 */
export function renderMiningReportHtml(report: MiningReport): string {
  const best = report.results[0];
  const bestParams = best?.params ?? {};
  const paramHeaders = Object.keys(bestParams);
  const gapLines = [
    ...report.quality.gaps.priceGaps.slice(0, 50).map(
      (gap) => `<li>${escapeHtml(gap.stock_code)}：缺失 ${gap.missing_dates.length} 个交易日（${escapeHtml(gap.missing_dates.slice(0, 10).join('、'))}）</li>`,
    ),
    ...report.quality.gaps.adjustmentIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`),
    ...(report.quality.gaps.limitUpMissingDates.length
      ? [`<li>缺少涨停记录的交易日 ${report.quality.gaps.limitUpMissingDates.length} 天：${escapeHtml(report.quality.gaps.limitUpMissingDates.slice(0, 20).join('、'))}</li>`]
      : []),
  ];

  const warningItems = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>策略挖掘报告 ${escapeHtml(report.runId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; padding: 32px; line-height: 1.6; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; text-align: right; white-space: nowrap; }
  th { background: #f3f4f6; font-weight: 600; }
  td.best { background: #dcfce7; font-weight: 600; }
  tr.unstable td { background: #fef2f2; }
  .bad { color: #b91c1c; font-weight: 600; }
  .ok { color: #15803d; font-weight: 600; }
  ul { margin: 6px 0 0 18px; padding: 0; }
  .box { border: 1px solid #d1d5db; border-radius: 8px; padding: 12px 16px; }
</style>
</head>
<body>
<h1>策略挖掘报告</h1>
<div class="meta">
  runId <code>${escapeHtml(report.runId)}</code> ·
  生成时间 ${escapeHtml(report.createdAt)} ·
  代码版本 <code>${escapeHtml(report.codeVersion)}</code> ·
  数据版本 <code>${escapeHtml(report.dataVersion)}</code><br/>
  标的池 ${report.universe.length} 只 · 启用子策略 ${escapeHtml(report.strategies.join(', '))} ·
  数据截至 ${escapeHtml(report.quality.asOfDate)}
</div>

<h2>数据质量</h2>
<div class="box">
  <div>结论：<span class="${report.quality.ok ? 'ok' : 'bad'}">${report.quality.ok ? '通过' : '未通过'}</span></div>
  <div>行情连续性覆盖率：${(report.quality.priceCoverageRatio * 100).toFixed(1)}%（覆盖 ${report.quality.coveredStocks}/${report.quality.universeSize}）</div>
  <div>涨停记录覆盖率：${(report.quality.limitUpCoverageRatio * 100).toFixed(1)}%</div>
  <div>复权：${report.quality.adjusted ? '已前复权' : '未复权'}</div>
  ${report.quality.reasons.length ? `<ul>${report.quality.reasons.map((reason) => `<li class="bad">${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
  ${gapLines.length ? `<div>缺口明细：</div><ul>${gapLines.join('')}</ul>` : '<div>无缺口。</div>'}
</div>

<h2>参数轨迹样本外表现</h2>
<div class="box">
  <div>年化收益 ${metricCell(report.aggregate.annualReturn)}% · 最大回撤 ${metricCell(report.aggregate.maxDrawdown)}% · 夏普 ${metricCell(report.aggregate.sharpe, 4)} · 胜率 ${metricCell(report.aggregate.winRate, 1)}% · 交易 ${report.aggregate.tradeCount} 笔</div>
  ${warningItems ? `<div>提示：</div><ul>${warningItems}</ul>` : ''}
</div>

<h2>候选参数排名</h2>
<table>
  <thead>
    <tr>
      <th>#</th>
      ${paramHeaders.map((key) => `<th>${escapeHtml(key)}</th>`).join('')}
      <th>样本外年化%</th><th>样本外回撤%</th><th>样本外夏普</th><th>样本外胜率%</th>
      <th>盈亏比</th><th>交易笔数</th><th>稳定性得分</th><th>样本内夏普</th><th>稳定性判定</th>
    </tr>
  </thead>
  <tbody>
    ${report.results.map((result) => resultRow(result, bestParams)).join('')}
  </tbody>
</table>
</body>
</html>`;
}

/** 报告摘要（写入 MiningRun 之外的轻量结构，便于列表展示）。 */
export function summarizeMiningReport(report: MiningReport): {
  runId: string;
  createdAt: string;
  bestParams: Record<string, number>;
  bestOutOfSample: MiningResult['outOfSample'];
  stabilityScore: number;
  qualityOk: boolean;
} {
  const best = report.results[0];
  return {
    runId: report.runId,
    createdAt: report.createdAt,
    bestParams: best?.params ?? {},
    bestOutOfSample: best?.outOfSample ?? {
      annualReturn: 0,
      maxDrawdown: 0,
      sharpe: 0,
      winRate: 0,
      profitFactor: 0,
      tradeCount: 0,
      turnover: 0,
    },
    stabilityScore: round(best?.stabilityScore ?? 0, 4),
    qualityOk: report.quality.ok,
  };
}
