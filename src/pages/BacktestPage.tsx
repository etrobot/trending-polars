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
import type { BacktestListItem, BacktestResult, BacktestTrade, TaskSnapshot } from '../types';

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

export function BacktestPage() {
  const { setPanelOpen } = useTasks();
  const [history, setHistory] = useState<BacktestListItem[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runTaskId, setRunTaskId] = useState<string | null>(null);
  const [collectTaskId, setCollectTaskId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [days, setDays] = useState(20);
  const [maxHoldDays, setMaxHoldDays] = useState(5);

  const loadHistory = useCallback(async () => {
    const items = await api<BacktestListItem[]>('/api/backtest/list');
    setHistory(items);
    if (!result && items[0]) {
      const latest = await api<BacktestResult>(`/api/backtest/${items[0].run_id}`);
      setResult(latest);
    }
  }, [result]);

  useEffect(() => {
    void loadHistory().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError))).finally(() => setLoading(false));
  }, [loadHistory]);

  const onRunDone = useCallback(async (task: TaskSnapshot) => {
    setRunTaskId(null);
    setRunning(false);
    if (task.status !== 'completed') {
      setError(task.message || '回测未完成');
      return;
    }
    try {
      const detail = await api<TaskSnapshot>(`/api/tasks/${task.id}`);
      const runId = (detail.result as { run_id?: string } | undefined)?.run_id;
      if (runId) setResult(await api<BacktestResult>(`/api/backtest/${runId}`));
      await loadHistory();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [loadHistory]);
  useTaskResult(runTaskId, onRunDone);

  const onCollectDone = useCallback((task: TaskSnapshot) => {
    setCollectTaskId(null);
    if (task.status !== 'completed') setError(task.message || '历史行情采集未完成');
  }, []);
  useTaskResult(collectTaskId, onCollectDone);

  const run = async () => {
    setSettingsOpen(false);
    setRunning(true);
    setError('');
    try {
      const response = await api<{ task_id: string }>(`/api/backtest/run?days=${days}&max_hold_days=${maxHoldDays}`, { method: 'POST' });
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

  const headerActions = <>
    <Button variant="secondary" onClick={() => setHistoryOpen(true)}><Clock3 className="h-3.5 w-3.5" />历史记录</Button>
    <Button variant="ghost" disabled={loading} onClick={() => void loadHistory()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
    <Button variant="primary" disabled={running} onClick={() => setSettingsOpen(true)}><Play className="h-3.5 w-3.5" />{running ? '回测进行中' : '运行回测'}</Button>
  </>;

  if (loading && !result) return <><PageHeaderActions>{headerActions}</PageHeaderActions><LoadingPanel label="正在读取回测历史…" /></>;

  return (
    <>
      <PageHeaderActions>{headerActions}</PageHeaderActions>
      <div className="terminal-page">
      {error && <div className="border border-accent-red-soft bg-accent-red-soft px-3 py-2 font-mono text-[11px] text-trading-up">{error}</div>}

      {!result ? (
        <div className="panel"><EmptyState title="还没有可展示的回测" description="先运行一次策略回测，系统会自动构建可复现的历史截面。" /></div>
      ) : (
        <>
        <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px_260px]">
          <div className="panel p-3.5">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2"><div><h2 className="font-display text-base text-ink">策略净值</h2>{result.engine_version && <div className="mt-0.5 font-mono text-[10px] text-muted">真实日线 · 收盘信号 / 次日开盘成交 · 含交易成本</div>}</div><div className="font-mono text-[11px] text-muted">{result.date_range}</div></div>
            <EquityCurve data={curve} />
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

          <section className="panel p-3.5"><h2 className="font-display text-base text-ink">参数</h2><div className="mt-3 space-y-2">{[['仓位比例', `${result.config.position_size_pct}% / 单票`], ['最大持仓', `${result.config.max_hold_days} 个交易日`], ['每日新增', `≤ ${result.config.max_positions_per_day} 只`], ['止损 / 止盈', `${result.config.stop_loss_pct}% / +${result.config.take_profit_pct}%`], ['候选池', `前 ${result.config.max_candidates} 名`], ...(result.engine_version ? [['成交假设', 'T+1 开盘 + 滑点税费']] : [])].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 border-b border-line-soft pb-2 font-mono text-[11px]"><span className="text-muted">{label}</span><span className="text-right text-ink">{value}</span></div>)}</div><div className="mt-4 flex items-center gap-2 font-mono text-[11px] text-muted"><CalendarRange className="h-3 w-3" />{result.timestamp}</div></section>
        </section>

        <section>
          <SectionHeading title="交易记录" description={`${result.trades.length} 条`} />
          <div className="table-scroll"><table className="data-table min-w-[1040px]"><thead><tr><th>日期</th><th>代码</th><th>名称</th><th className="text-center">操作</th><th className="text-right">价格</th><th className="text-right">数量</th><th className="text-right">金额</th><th className="text-right">仓位</th><th className="text-right">持仓日</th><th className="text-right">盈亏</th><th>原因</th></tr></thead><tbody>{result.trades.map((trade, index) => <tr key={`${trade.date}-${trade.stock_code}-${index}`}><td className="font-mono text-xs">{trade.date}</td><td className="font-mono text-xs text-muted">{trade.stock_code}</td><td className="font-semibold text-ink">{trade.stock_name}</td><td className={`text-center text-xs ${tradeAction(trade.action)}`}>{trade.action}</td><td className="text-right font-mono text-xs">{trade.price.toFixed(2)}</td><td className="text-right font-mono text-xs">{trade.shares.toLocaleString()}</td><td className="text-right font-mono text-xs">{formatMoney(trade.amount)}</td><td className="text-right font-mono text-xs">{trade.position_pct.toFixed(1)}%</td><td className="text-right font-mono text-xs">{trade.hold_days}</td><td className={`text-right font-mono text-xs ${trade.pnl_pct > 0 ? 'text-trading-up' : trade.pnl_pct < 0 ? 'text-trading-down' : 'text-muted'}`}>{trade.pnl_pct > 0 ? '+' : ''}{trade.pnl_pct.toFixed(2)}%</td><td className="max-w-sm whitespace-normal text-xs text-muted">{trade.reason}</td></tr>)}</tbody></table></div>
        </section>
        </>
      )}

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="回测设置" description="选择时间范围与持仓上限，开始一次可复现的策略模拟。">
        <div className="space-y-4"><label className="block"><span className="font-mono text-[11px] text-muted">回测区间</span><div className="mt-2 flex items-center gap-3"><input type="range" min="5" max="60" step="5" value={days} onChange={(event) => setDays(Number(event.target.value))} className="w-full accent-primary" /><span className="w-11 border border-line bg-surface px-2 py-1.5 text-center font-mono text-[11px]">{days}</span></div><span className="mt-1 block text-[11px] text-muted">最近 {days} 个交易日</span></label><label className="block"><span className="font-mono text-[11px] text-muted">最大持仓日</span><div className="mt-2 flex items-center gap-3"><input type="range" min="1" max="20" value={maxHoldDays} onChange={(event) => setMaxHoldDays(Number(event.target.value))} className="w-full accent-primary" /><span className="w-11 border border-line bg-surface px-2 py-1.5 text-center font-mono text-[11px]">{maxHoldDays}</span></div><span className="mt-1 block text-[11px] text-muted">超过持仓日数后在下一交易日开盘退出</span></label><div className="bg-surface-elevated p-3 text-[11px] leading-4 text-muted">规则：仅用信号日及以前行情计算排名，次日开盘成交；止损 -5% · 止盈 +15% · 单票 10%，并计入滑点、佣金与印花税。</div><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => void collect()}>采集真实历史日线</Button><Button variant="primary" onClick={() => void run()}><Play className="h-3.5 w-3.5" />开始回测</Button></div></div>
      </Modal>

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="回测历史" description="选择一条记录查看完整的净值与交易账本。" width="max-w-xl">
        <div className="divide-y divide-line-soft border border-line bg-surface">{history.length === 0 ? <EmptyState title="暂无历史记录" /> : history.map((item) => <div key={item.run_id} className="flex items-center gap-3 p-3"><button className="focus-ring min-w-0 flex-1 text-left" onClick={() => void loadRun(item.run_id)}><div className="flex items-center justify-between gap-3"><span className="font-mono text-[11px] text-ink">{item.timestamp}</span><span className={`font-mono text-[11px] ${pctColor(item.total_return_pct)}`}>{item.total_return_pct > 0 ? '+' : ''}{item.total_return_pct.toFixed(2)}%</span></div><div className="mt-1 text-[11px] text-muted">{item.date_range} · {item.total_trades} 笔 · 胜率 {item.win_rate}%</div></button><button className="focus-ring border border-transparent p-1.5 text-muted hover:border-accent-red-soft hover:bg-accent-red-soft hover:text-trading-up" onClick={() => void deleteRun(item.run_id)} aria-label="删除回测"><Trash2 className="h-3.5 w-3.5" /></button><ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" /></div>)}</div>
      </Modal>
      </div>
    </>
  );
}
