import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarRange,
  ChevronRight,
  Clock3,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { EquityCurve } from '../components/Charts';
import { PageHeaderActions } from '../components/HeaderActions';
import { Modal } from '../components/Modal';
import { Button, EmptyState, LoadingPanel, SectionHeading } from '../components/Ui';
import { useTaskResult, useTasks } from '../context/TasksContext';
import { api, formatMoney, pctColor } from '../lib/api';
import type { BacktestListItem, BacktestResult, BacktestTrade, EquityPoint, TaskSnapshot } from '../types';

function curveFromTrades(result: BacktestResult) {
  if (result.equity_curve?.length) return result.equity_curve;
  const points: Array<{ date: string; total: number }> = [];
  let total = Number(result.summary.initial_capital ?? 100_000);
  for (const trade of result.trades ?? []) {
    if (trade.action === '卖出') total += Number(trade.pnl_amount ?? trade.amount * (trade.pnl_pct / 100));
    points.push({ date: trade.date, total: Number(total.toFixed(2)) });
  }
  return points;
}

function tradeAction(action: BacktestTrade['action']) {
  return action === '买入' ? 'text-trading-up' : 'text-trading-down';
}

function historyItemTitle(item: BacktestListItem) {
  if (item.mode === 'random' && (item.strategy_count ?? 1) > 1) {
    return `随机组合 ${item.combo_index}/${item.strategy_count}`;
  }
  return item.mode === 'current' ? '当前方案' : '随机组合';
}

function historyItemDetail(item: BacktestListItem) {
  const parts = [
    item.position_size_pct ? <>仓位<span className="text-ink">{item.position_size_pct}%</span></> : null,
    item.max_positions ? <>持仓<span className="text-ink">{item.max_positions} 只</span></> : null,
    item.max_hold_days ? <>持有<span className="text-ink">{item.max_hold_days} 天</span></> : null,
    item.date_range ? <span className="text-ink">{item.date_range}</span> : null,
    <><span className="text-ink">{item.total_trades}</span> 笔</>,
    <>胜率<span className="text-ink">{item.win_rate}%</span></>,
  ].filter(Boolean);
  return <>{parts.map((p, i) => i === 0 ? p : <><span className="mx-1 text-muted">·</span>{p}</>)}</>;
}

export function BacktestPage() {
  const { setPanelOpen } = useTasks();
  const [history, setHistory] = useState<BacktestListItem[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [runTaskId, setRunTaskId] = useState<string | null>(null);
  const [collectTaskId, setCollectTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [days, setDays] = useState(20);
  const [strategyCount, setStrategyCount] = useState(3);
  const [positionSizePct, setPositionSizePct] = useState(10);
  const [maxPositions, setMaxPositions] = useState(10);
  const [maxHoldDays, setMaxHoldDays] = useState(5);
  const [takeProfitPct, setTakeProfitPct] = useState(15);
  const [stopLossPct, setStopLossPct] = useState(5);

  const loadHistoryList = useCallback(async () => {
    const items = await api<BacktestListItem[]>('/api/backtest/list');
    console.log('[backtest] history list loaded', items.length, items.slice(0, 5).map((item) => item.run_id));
    setHistory(items);
    return items;
  }, []);

  const loadHistory = useCallback(async () => {
    const items = await loadHistoryList();
    if (!result && items[0]) {
      const latest = await api<BacktestResult>(`/api/backtest/${items[0].run_id}`);
      setResult(latest);
    }
  }, [loadHistoryList, result]);

  useEffect(() => {
    void loadHistory().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError))).finally(() => setLoading(false));
  }, [loadHistory]);

  useEffect(() => {
    if (!historyOpen) return;
    void loadHistoryList().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [historyOpen, loadHistoryList]);

  const onRunDone = useCallback(async (task: TaskSnapshot) => {
    setRunTaskId(null);
    setRunning(false);
    if (task.status !== 'completed') {
      setError(task.message || '回测未完成');
      setNotice('');
      return;
    }
    try {
      const detail = await api<TaskSnapshot>(`/api/tasks/${task.id}`);
      const payload = detail.result as { run_id?: string; run_ids?: string[]; message?: string } | undefined;
      const runIds = payload?.run_ids?.length
        ? payload.run_ids
        : payload?.run_id
          ? [payload.run_id]
          : [];
      console.log('[backtest] task completed', { run_ids: runIds, message: task.message ?? payload?.message });
      await loadHistoryList();
      setError('');
      if (runIds.length > 1) {
        setResult(await api<BacktestResult>(`/api/backtest/${runIds[0]}`));
        setNotice(`已生成 ${runIds.length} 条回测记录，可在历史记录中逐条查看（当前展示第 1 组）`);
        setHistoryOpen(true);
      } else if (runIds.length) {
        setResult(await api<BacktestResult>(`/api/backtest/${runIds[0]}`));
        setNotice('');
      } else {
        setNotice(payload?.message ?? task.message ?? '回测已完成');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setNotice('');
    }
  }, [loadHistoryList]);
  useTaskResult(runTaskId, onRunDone);

  const onCollectDone = useCallback((task: TaskSnapshot) => {
    setCollectTaskId(null);
    if (task.status !== 'completed') setError(task.message || '历史行情采集未完成');
  }, []);
  useTaskResult(collectTaskId, onCollectDone);

  const run = async (mode: 'current' | 'random') => {
    setSettingsOpen(false);
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const params = new URLSearchParams({
        mode,
        days: String(days),
        strategy_count: String(strategyCount),
        position_size_pct: String(positionSizePct),
        max_positions: String(maxPositions),
        max_hold_days: String(maxHoldDays),
        take_profit_pct: String(takeProfitPct),
        stop_loss_pct: String(stopLossPct),
      });
      console.log('[backtest] start run', Object.fromEntries(params.entries()));
      const response = await api<{ task_id: string }>(`/api/backtest/run?${params.toString()}`, { method: 'POST' });
      setRunTaskId(response.task_id);
      setPanelOpen(true);
    } catch (runError) {
      setRunning(false);
      setError(runError instanceof Error ? runError.message : String(runError));
    }
  };

  const collect = async () => {
    try {
      const response = await api<{ task_id: string }>(`/api/backtest/collect?days=${days}`, { method: 'POST' });
      setCollectTaskId(response.task_id);
      setPanelOpen(true);
    } catch (collectError) {
      setError(collectError instanceof Error ? collectError.message : String(collectError));
    }
  };

  const loadRun = async (runId: string) => {
    setHistoryOpen(false);
    setLoading(true);
    try {
      setResult(await api<BacktestResult>(`/api/backtest/${runId}`));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  const deleteRun = async (runId: string) => {
    if (!window.confirm('确定删除这次回测记录吗？')) return;
    await api(`/api/backtest/${runId}`, { method: 'DELETE' });
    setHistory((items) => items.filter((item) => item.run_id !== runId));
    if (result?.run_id === runId) setResult(null);
  };

  const curve = useMemo(() => result ? curveFromTrades(result) : [], [result]);
  const resultDays = Number(result?.config.days ?? days);
  const resultMode = String(result?.config?.mode ?? 'random');
  const configNumber = (key: string) => Number(result?.config?.[key] ?? 0);

  const [benchmark, setBenchmark] = useState<EquityPoint[] | null>(null);
  useEffect(() => {
    if (!curve.length) { setBenchmark(null); return; }
    setBenchmark(null);
    const dates = curve.map((p) => p.date).join(',');
    const initialCapital = curve[0].total;
    fetch(`/api/benchmark?dates=${dates}&initial_capital=${initialCapital}`)
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
      .then((data) => { if (data.curve?.length) setBenchmark(data.curve); })
      .catch(() => {/* benchmark 可选，失败不阻塞 */});
  }, [curve]);

  const openHistory = () => {
    void loadHistoryList()
      .then(() => setHistoryOpen(true))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  };

  const headerActions = <>
    <Button variant="secondary" onClick={openHistory}><Clock3 className="h-3.5 w-3.5" />历史记录{history.length ? ` (${history.length})` : ''}</Button>
    <Button variant="ghost" disabled={loading} onClick={() => void loadHistory()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
    <Button variant="primary" disabled={running} onClick={() => setSettingsOpen(true)}><Play className="h-3.5 w-3.5" />{running ? '回测进行中' : '运行回测'}</Button>
  </>;

  if (loading && !result) return <><PageHeaderActions>{headerActions}</PageHeaderActions><LoadingPanel label="正在读取回测历史…" /></>;

  return (
    <>
      <PageHeaderActions>{headerActions}</PageHeaderActions>
      <div className="terminal-page">
      {error && <div className="border border-accent-red-soft bg-accent-red-soft px-3 py-2 font-mono text-[11px] text-trading-up">{error}</div>}
      {notice && <div className="border border-line bg-surface-elevated px-3 py-2 font-mono text-[11px] text-ink">{notice}</div>}

      {!result ? (
        <div className="panel"><EmptyState title="还没有可展示的回测" description="先运行一次策略回测，系统会自动构建可复现的历史截面。" /></div>
      ) : (
        <>
        <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px_260px]">
          <div className="panel p-3.5">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2"><h2 className="font-display text-base text-ink">回测走势（{resultDays}天）</h2><div className="font-mono text-[11px] text-muted">{result.date_range}</div></div>
            <EquityCurve data={curve} benchmark={benchmark ?? undefined} />
          </div>

          <section className="panel overflow-hidden">
            <div className="module-header"><h2 className="font-display text-base text-ink">回测统计</h2></div>
            <div className="divide-y divide-line-soft">
              {[
                ['初始资金', formatMoney(result.summary.initial_capital), 'text-ink'],
                ['期末资金', formatMoney(result.summary.final_capital), 'text-ink'],
                ['总收益', formatMoney(result.summary.total_return), pctColor(result.summary.total_return)],
                ['收益率', `${result.summary.total_return_pct >= 0 ? '+' : ''}${result.summary.total_return_pct.toFixed(2)}%`, pctColor(result.summary.total_return_pct)],
                ['胜率', `${result.summary.win_rate.toFixed(1)}%`, 'text-ink'],
                ['最大回撤', `${(result.summary.max_drawdown_pct ?? 0).toFixed(2)}%`, 'text-trading-down'],
                ['交易数', String(result.summary.total_trades), 'text-ink'],
                ['最大持仓', `${result.summary.max_holdings} 只`, 'text-ink'],
              ].map(([label, value, valueClass]) => <div key={label} className="flex items-center justify-between gap-3 px-3 py-2.5"><span className="text-[11px] text-muted">{label}</span><span className={`font-mono text-[11px] ${valueClass}`}>{value}</span></div>)}
            </div>
          </section>

          <section className="panel p-3.5"><h2 className="font-display text-base text-ink">参数</h2><div className="mt-3 space-y-2">{[
            ['回测模式', resultMode === 'current' ? '当前方案' : '随机组合'],
            ...(resultMode === 'random' ? [
              ['策略组合个数', `${configNumber('strategy_count')} 组`],
              ['当前组合', `第 ${configNumber('combo_index')} / ${configNumber('strategy_count')} 组`],
            ] : []),
            ['单票仓位', `${configNumber('position_size_pct')}%`],
            ['持仓个数', `${configNumber('max_positions')} 只`],
            ['个股持仓天数', `${configNumber('max_hold_days')} 天`],
            ['止损', `${configNumber('stop_loss_pct')}%`],
            ['止盈', `+${configNumber('take_profit_pct')}%`],
            ['每日新增', `≤ ${configNumber('max_positions_per_day')} 只`],
            ['候选池', `前 ${configNumber('max_candidates')} 名`],
            ...(result.engine_version ? [['成交假设', 'T+1 开盘 + 滑点税费']] : []),
          ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 border-b border-line-soft pb-2 font-mono text-[11px]"><span className="text-muted">{label}</span><span className="text-right text-ink">{value}</span></div>)}</div><div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-muted"><CalendarRange className="h-3 w-3" />{result.timestamp}</div></section>
        </section>

        <section>
          <SectionHeading title="交易记录" description={`${result.trades.length} 条`} />
          <div className="table-scroll"><table className="data-table min-w-[1040px]"><thead><tr><th>日期</th><th>代码</th><th>名称</th><th className="text-center">操作</th><th className="text-right">价格</th><th className="text-right">数量</th><th className="text-right">金额</th><th className="text-right">仓位</th><th className="text-right">持仓日</th><th className="text-right">盈亏</th><th>原因</th></tr></thead><tbody>{result.trades.map((trade, index) => <tr key={`${trade.date}-${trade.stock_code}-${index}`}><td className="font-mono text-xs">{trade.date}</td><td className="font-mono text-xs text-muted">{trade.stock_code}</td><td className="font-semibold text-ink">{trade.stock_name}</td><td className={`text-center text-xs ${tradeAction(trade.action)}`}>{trade.action}</td><td className="text-right font-mono text-xs">{trade.price.toFixed(2)}</td><td className="text-right font-mono text-xs">{trade.shares.toLocaleString()}</td><td className="text-right font-mono text-xs">{formatMoney(trade.amount)}</td><td className="text-right font-mono text-xs">{trade.position_pct.toFixed(1)}%</td><td className="text-right font-mono text-xs">{trade.hold_days}</td><td className={`text-right font-mono text-xs ${trade.pnl_pct > 0 ? 'text-trading-up' : trade.pnl_pct < 0 ? 'text-trading-down' : 'text-muted'}`}>{trade.pnl_pct > 0 ? '+' : ''}{trade.pnl_pct.toFixed(2)}%</td><td className="max-w-sm whitespace-normal text-xs text-muted">{trade.reason}</td></tr>)}</tbody></table></div>
        </section>
        </>
      )}

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="回测设置" description="回测天数与策略组合个数为固定值；其余参数：当前方案按原值使用，随机组合则作为取参上限。">
        <div className="space-y-4">
          <label className="block"><span className="font-mono text-[11px] text-muted">回测天数（固定）</span><input type="number" min="5" max="60" step="5" value={days} onChange={(event) => setDays(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
          <label className="block"><span className="font-mono text-[11px] text-muted">策略组合个数（固定，仅随机组合使用）</span><input type="number" min="1" max="200" step="1" value={strategyCount} onChange={(event) => setStrategyCount(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="font-mono text-[11px] text-muted">单票仓位（%）（当前取值 / 随机上限）</span><input type="number" min="1" max="100" value={positionSizePct} onChange={(event) => setPositionSizePct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">持仓个数（当前取值 / 随机上限）</span><input type="number" min="1" max="20" value={maxPositions} onChange={(event) => setMaxPositions(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">个股持仓天数（当前取值 / 随机上限）</span><input type="number" min="1" max="60" value={maxHoldDays} onChange={(event) => setMaxHoldDays(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">止盈（%）（当前取值 / 随机上限）</span><input type="number" min="1" max="60" value={takeProfitPct} onChange={(event) => setTakeProfitPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block sm:col-span-2"><span className="font-mono text-[11px] text-muted">止损（%）（当前取值 / 随机上限）</span><input type="number" min="1" max="30" value={stopLossPct} onChange={(event) => setStopLossPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
          </div>
          <div className="bg-surface-elevated p-3 text-[11px] leading-4 text-muted">
            回测当前方案：直接使用上方参数原值跑 1 组结果。回测随机组合：在上限内随机取参，分别跑 {strategyCount} 组独立回测，可在历史记录中逐条查看。
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => void collect()}>采集真实历史日线</Button>
            <Button variant="secondary" disabled={running} onClick={() => void run('current')}><Play className="h-3.5 w-3.5" />回测当前方案</Button>
            <Button variant="primary" disabled={running} onClick={() => void run('random')}><Play className="h-3.5 w-3.5" />回测随机组合</Button>
          </div>
        </div>
      </Modal>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="回测历史" description={`共 ${history.length} 条记录。随机组合批次会分别保存，可按组合序号切换查看。`} width="max-w-xl">
        <div className="divide-y divide-line-soft border border-line bg-surface">{history.length === 0 ? <EmptyState title="暂无历史记录" /> : history.map((item) => <div key={item.run_id} className="flex items-center gap-3 p-3"><button className="focus-ring min-w-0 flex-1 text-left" onClick={() => void loadRun(item.run_id)}><div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="font-mono text-[11px] text-ink">{historyItemTitle(item)}</div><div className="mt-0.5 font-mono text-[10px] text-muted">{item.timestamp} · {item.run_id}</div></div><span className={`shrink-0 font-mono text-[11px] ${pctColor(item.total_return_pct)}`}>{item.total_return_pct > 0 ? '+' : ''}{item.total_return_pct.toFixed(2)}%</span></div><div className="mt-1 text-[11px] text-muted">{historyItemDetail(item)}</div></button><button className="focus-ring border border-transparent p-1.5 text-muted hover:border-accent-red-soft hover:bg-accent-red-soft hover:text-trading-up" onClick={() => void deleteRun(item.run_id)} aria-label="删除回测"><Trash2 className="h-3.5 w-3.5" /></button><ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" /></div>)}</div>
      </Modal>
      </div>
    </>
  );
}
