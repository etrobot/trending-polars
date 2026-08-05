import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CirclePause,
  CirclePlay,
  ClipboardCheck,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { Modal } from '../components/Modal';
import { PageHeaderActions } from '../components/HeaderActions';
import { MiniEquityChart } from '../components/Charts';
import { Button, EmptyState, LoadingPanel, Pagination, SectionHeading } from '../components/Ui';
import { useTaskResult, useTasks } from '../context/TasksContext';
import { api, formatMoney, pctColor } from '../lib/api';
import { clientImmediateAutoRejection } from '../lib/trading-session';
import type { AutomationState, BacktestListItem, PaperOverview, PaperPlanHistoryItem, TaskSnapshot, TradingSession, TradingWindow } from '../types';

const HISTORY_PAGE_SIZE = 15;
const BACKTEST_HISTORY_PAGE_SIZE = 15;

function historyItemTitle(item: BacktestListItem) {
  if (item.mode === 'random' && (item.strategy_count ?? 1) > 1) {
    return `随机组合 ${item.combo_index}/${item.strategy_count}`;
  }
  return item.mode === 'current' ? '当前方案' : '随机组合';
}

function historyStatusTone(status: string): string {
  if (status.includes('成交')) return 'text-green';
  if (status.includes('不确定') || status.includes('失败')) return 'text-trading-up';
  if (status.includes('待') || status.includes('提交中') || status.includes('已提交')) return 'text-primary-active';
  return 'text-muted';
}

function PlanHistoryTable({
  history,
  page,
  pageSize,
  onPage,
  emptyTitle = '尚无已执行计划',
  emptyDescription = '决策生成的计划执行后会显示在这里。历史记录会持久保存在 Node.js 交易状态中。',
}: {
  history: PaperPlanHistoryItem[];
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(history.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const pageItems = history.slice(offset, offset + pageSize);

  return (
    <>
      <div className="overflow-auto">
        <table className="data-table min-w-[1180px]">
          <thead><tr><th>信号日</th><th>方向</th><th>状态</th><th>代码</th><th>名称</th><th className="text-right">排名</th><th className="text-right">数量</th><th className="text-right">参考/成交价</th><th>创建时间</th><th>提交/完成时间</th><th>原因与回查状态</th></tr></thead>
          <tbody>{pageItems.length === 0 ? <tr><td colSpan={11}><EmptyState title={emptyTitle} description={emptyDescription} /></td></tr> : pageItems.map((item) => (
            <tr key={item.id}>
              <td className="font-mono text-xs text-muted">{item.signal_date}</td>
              <td className={item.side === 'buy' ? 'font-semibold text-trading-up' : 'font-semibold text-trading-down'}>{item.side === 'buy' ? '买入' : '卖出'}</td>
              <td className={`font-mono text-xs ${historyStatusTone(item.status)}`}>{item.status}</td>
              <td className="font-mono text-xs text-muted">{item.stock_code}</td>
              <td className="font-semibold text-ink">{item.stock_name}</td>
              <td className="text-right font-mono text-xs">{item.rank ?? '—'}</td>
              <td className="text-right font-mono text-xs">{item.quantity.toLocaleString()}</td>
              <td className="text-right font-mono text-xs">{item.price.toFixed(2)}</td>
              <td className="font-mono text-xs text-muted">{item.created_at}</td>
              <td className="font-mono text-xs text-muted">{item.completed_at ?? item.submitted_at ?? '—'}</td>
              <td className="max-w-sm whitespace-normal text-xs text-muted">{item.reason}{item.broker_status ? `；${item.broker_status}` : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {totalPages > 1 && <Pagination page={safePage} pages={totalPages} onPage={onPage} />}
    </>
  );
}

export function SimulatedTradingPage() {
  const { setPanelOpen } = useTasks();
  const [overview, setOverview] = useState<PaperOverview | null>(null);
  const [automation, setAutomation] = useState<AutomationState | null>(null);
  const [tradingSession, setTradingSession] = useState<TradingSession | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [executeOpen, setExecuteOpen] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<TradingWindow | 'auto'>('auto');
  const [connected, setConnected] = useState(false);
  const [planTab, setPlanTab] = useState<'pending' | 'executed' | 'expired'>('pending');
  const [historyPage, setHistoryPage] = useState(1);
  const [backtestHistoryOpen, setBacktestHistoryOpen] = useState(false);
  const [backtestHistory, setBacktestHistory] = useState<BacktestListItem[]>([]);
  const [backtestHistoryLoading, setBacktestHistoryLoading] = useState(false);
  const [backtestHistoryPage, setBacktestHistoryPage] = useState(1);
  const [backtestSortColumn, setBacktestSortColumn] = useState<'win_rate' | 'total_return_pct' | null>(null);
  const [backtestSortDirection, setBacktestSortDirection] = useState<'asc' | 'desc'>('desc');
  const [applyingBacktestRunId, setApplyingBacktestRunId] = useState('');
  const [windowTaskId, setWindowTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const refreshInFlight = useRef<Promise<void> | null>(null);

  const loadBootstrap = useCallback(async () => {
    try {
      const result = await api<{ overview: PaperOverview; automation: AutomationState; trading_session: TradingSession }>('/api/simulated-trading/bootstrap');
      setOverview(result.overview);
      setAutomation(result.automation);
      setTradingSession(result.trading_session);
      setError('');
    } catch (bootstrapError) {
      setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
    }
  }, []);

  const onWindowTaskDone = useCallback((task: TaskSnapshot) => {
    setWindowTaskId(null);
    if (task.status !== 'completed') {
      setNotice('');
      setError(task.message || '交易窗口执行未完成');
      return;
    }
    setError('');
    setNotice(task.message || '交易窗口执行完成');
    void loadBootstrap();
  }, [loadBootstrap]);
  useTaskResult(windowTaskId, onWindowTaskDone);

  const refreshAccount = useCallback((): Promise<void> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    setConnecting(true);
    const operation = api<PaperOverview>('/api/simulated-trading/overview')
      .then((nextOverview) => {
        setOverview(nextOverview);
        setError('');
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        setConnecting(false);
        refreshInFlight.current = null;
      });
    refreshInFlight.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    void loadBootstrap().finally(() => refreshAccount());
  }, [loadBootstrap, refreshAccount]);

  const loadBacktestHistory = useCallback(async () => {
    setBacktestHistoryLoading(true);
    try {
      const items = await api<BacktestListItem[]>('/api/backtest/list');
      console.log('[simulated-trading] backtest history loaded', items.length);
      setBacktestHistory(items);
      setError('');
      return items;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      return [];
    } finally {
      setBacktestHistoryLoading(false);
    }
  }, []);

  const openBacktestHistory = () => {
    setBacktestHistoryPage(1);
    setBacktestSortColumn(null);
    setBacktestSortDirection('desc');
    setBacktestHistoryOpen(true);
    void loadBacktestHistory();
  };

  const closeBacktestHistory = () => {
    setBacktestHistoryOpen(false);
    setBacktestHistoryPage(1);
    setApplyingBacktestRunId('');
  };

  const applyBacktestParams = async (runId: string) => {
    setApplyingBacktestRunId(runId);
    setError('');
    try {
      const applied = await api<{
        ok: boolean;
        run_id: string;
        strategy: Record<string, number>;
        plan: {
          target_position_pct: number;
          position_size_pct: number;
          max_positions: number;
          max_entries_per_day: number;
          max_hold_days: number;
          stop_loss_pct: number;
          take_profit_pct: number;
        };
        ranking?: {
          trendWeightPct: number;
          volumePriceWeightPct: number;
          distanceFromLowWeightPct: number;
          volatilityTrendWeightPct: number;
        };
        ranking_recomputed?: boolean;
        ranking_message?: string;
      }>(
        '/api/simulated-trading/strategy/apply-backtest',
        { method: 'POST', body: JSON.stringify({ run_id: runId }) },
      );
      console.log('[simulated-trading] applied backtest params', applied);
      const weights = applied.ranking;
      const weightSummary = weights
        ? `排行权重 趋势${weights.trendWeightPct}% 价量${weights.volumePriceWeightPct}% 距低点${weights.distanceFromLowWeightPct}% 波动${weights.volatilityTrendWeightPct}%`
        : '';
      setNotice(`已加载回测参数（${runId}）${weightSummary ? `；${weightSummary}` : ''}${applied.ranking_recomputed ? '；排行已重算' : applied.ranking_message ? `；${applied.ranking_message}` : ''}；退出规则 ${applied.plan.stop_loss_pct}% / +${applied.plan.take_profit_pct}% / ${applied.plan.max_hold_days}d`);
      setBacktestHistoryOpen(false);
      setOverview((prev) => (prev ? {
        ...prev,
        plan: {
          ...prev.plan,
          ...applied.plan,
        },
      } : prev));
      await loadBootstrap();
      setOverview((prev) => (prev ? {
        ...prev,
        plan: {
          ...prev.plan,
          ...applied.plan,
        },
      } : prev));
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplyingBacktestRunId('');
    }
  };

  const sortedBacktestHistory = useMemo(() => {
    if (!backtestSortColumn) return backtestHistory;
    return [...backtestHistory].sort((a, b) => {
      const valA = a[backtestSortColumn];
      const valB = b[backtestSortColumn];
      return backtestSortDirection === 'asc' ? valA - valB : valB - valA;
    });
  }, [backtestHistory, backtestSortColumn, backtestSortDirection]);

  const paginatedBacktestHistory = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(sortedBacktestHistory.length / BACKTEST_HISTORY_PAGE_SIZE));
    const safePage = Math.min(backtestHistoryPage, totalPages);
    const offset = (safePage - 1) * BACKTEST_HISTORY_PAGE_SIZE;
    return {
      items: sortedBacktestHistory.slice(offset, offset + BACKTEST_HISTORY_PAGE_SIZE),
      page: safePage,
      totalPages,
    };
  }, [sortedBacktestHistory, backtestHistoryPage]);

  const toggleBacktestSort = (column: 'win_rate' | 'total_return_pct') => {
    if (backtestSortColumn === column) {
      setBacktestSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setBacktestSortColumn(column);
      setBacktestSortDirection('desc');
    }
  };

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/simulated-trading`);
    socket.onopen = () => setConnected(true);
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; payload?: TradingSession };
        if (message.type === 'trading_session' && message.payload) {
          setTradingSession(message.payload);
          return;
        }
        if (message.type !== 'status') void loadBootstrap();
      } catch {
        void loadBootstrap();
      }
    };
    socket.onclose = () => setConnected(false);
    return () => socket.close();
  }, [loadBootstrap]);

  const toggleAutomation = async () => {
    if (!automation) return;
    setBusy(true);
    try {
      const result = await api<{ automation: AutomationState }>('/api/simulated-trading/automation/toggle', { method: 'POST', body: JSON.stringify({ enabled: !automation.enabled }) });
      setAutomation(result.automation);
      setError('');
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally { setBusy(false); }
  };

  const pause = async () => {
    setBusy(true);
    try {
      const endpoint = automation?.paused_today ? '/api/simulated-trading/automation/resume' : '/api/simulated-trading/automation/pause-today';
      const result = await api<{ automation: AutomationState }>(endpoint, { method: 'POST' });
      setAutomation(result.automation);
      setError('');
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : String(pauseError));
    } finally { setBusy(false); }
  };

  const execute = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ task_id: string; message?: string }>('/api/simulated-trading/automation/run-window', {
        method: 'POST',
        body: JSON.stringify({ window: selectedWindow }),
      });
      setExecuteOpen(false);
      setWindowTaskId(result.task_id);
      setNotice(result.message ?? '交易窗口已转入后台执行');
      setPanelOpen(true);
    } catch (executeError) {
      setError(executeError instanceof Error ? executeError.message : String(executeError));
    } finally { setBusy(false); }
  };

  const confirmWindow = (window: TradingWindow | 'auto') => {
    if (window === 'auto') {
      const clientRejection = clientImmediateAutoRejection();
      if (clientRejection) {
        console.log('[simulated-trading] immediate execute rejected (client)', clientRejection);
        setNotice('');
        setError(clientRejection);
        return;
      }
      if (tradingSession && !tradingSession.immediate_execute_allowed) {
        const reason = tradingSession.immediate_execute_reason ?? '当前不在交易时段，无法立即执行';
        console.log('[simulated-trading] immediate execute rejected (server session)', reason);
        setNotice('');
        setError(reason);
        return;
      }
    }
    setError('');
    setSelectedWindow(window);
    setExecuteOpen(true);
  };

  const account = overview?.account;
  const plan = overview?.plan;
  const hasAccountSnapshot = Boolean(overview && overview.connection.status !== 'unavailable' && (overview.account.positions.length > 0 || overview.connection.status === 'live'));
  const connectionLabel = connecting ? (hasAccountSnapshot ? `上次同步(${overview?.connection.observed_at?.slice(5, 16).replace('-', '/') ?? ''})` : '连接中') : overview?.connection.status === 'live' ? `已同步(${overview.connection.observed_at?.slice(5, 16).replace('-', '/') ?? ''})` : overview?.connection.status === 'cached' ? (hasAccountSnapshot ? '上次快照' : '未同步') : '未连接';
  const connectionDot = connecting ? 'bg-primary animate-pulse' : overview?.connection.status === 'live' && connected ? 'bg-green' : 'bg-muted';
  const tradingDisabled = busy || Boolean(windowTaskId) || connecting || !overview || overview.connection.status === 'unavailable';

  const executedHistory = plan?.history.filter((item) => {
    return ['filled', '已成交', 'skipped', '已跳过', 'failed', '失败', 'cancelled', '已撤'].some(
      (marker) => item.status.includes(marker),
    );
  }) ?? [];
  const expiredHistory = plan?.history.filter((item) => (
    item.status === 'expired' || item.status.includes('过期')
  )) ?? [];

  const tabStyle = (active: boolean) =>
    `px-3 py-1.5 font-mono text-[11px] transition cursor-pointer ${
      active
        ? 'border-b-2 border-primary-active text-primary-active bg-primary/5'
        : 'border-b-2 border-transparent text-muted hover:text-ink hover:bg-surface-elevated'
    }`;

  return (
    <>
      <PageHeaderActions>
        <span className="inline-flex h-7 shrink-0 items-center gap-1.5 bg-accent-green-soft px-2 font-mono text-[11px] text-trading-down" style={{ borderRadius: 2 }}><ShieldCheck className="h-3 w-3" />同花顺模拟</span>
        <span title={overview?.connection.observed_at ? `账户快照：${overview.connection.observed_at}` : connected ? '状态推送在线' : '状态推送正在重连'} className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-line bg-surface px-2 font-mono text-[11px] text-muted" style={{ borderRadius: 2 }}><span className={`h-1.5 w-1.5 ${connectionDot}`} />{connectionLabel}</span>
        <Button variant="secondary" className="shrink-0 whitespace-nowrap" disabled={busy || !automation} onClick={() => void toggleAutomation()}>{automation?.enabled ? <CirclePause className="h-3.5 w-3.5" /> : <CirclePlay className="h-3.5 w-3.5" />}自动化：{automation?.enabled ? '开' : '关'}</Button>
        <Button variant="ghost" className="shrink-0 whitespace-nowrap" disabled={busy || !automation?.enabled} onClick={() => void pause()}>{automation?.paused_today ? '恢复今日' : '暂停今日'}</Button>
        <Button variant="secondary" className="shrink-0 whitespace-nowrap" disabled={connecting} onClick={() => void refreshAccount()}><RefreshCw className={`h-3.5 w-3.5 ${connecting ? 'animate-spin' : ''}`} />{connecting ? '同步中' : '刷新账户'}</Button>
        <Button variant="ghost" className="shrink-0 whitespace-nowrap" disabled={busy} onClick={openBacktestHistory}><SlidersHorizontal className="h-3.5 w-3.5" />加载回测参数</Button>
        <Button variant="ghost" className="shrink-0 whitespace-nowrap" disabled={tradingDisabled} onClick={() => confirmWindow('post_close')}>盘后核对</Button>
        <Button variant="secondary" className="shrink-0 whitespace-nowrap" disabled={tradingDisabled} title="随时刷新行情并生成交易计划" onClick={() => confirmWindow('close')}><ClipboardCheck className="h-3.5 w-3.5" />决策</Button>
        <Button variant="primary" className="shrink-0 whitespace-nowrap" disabled={tradingDisabled} title="根据当前时间自动判断并执行对应窗口" onClick={() => confirmWindow('auto')}><ClipboardCheck className="h-3.5 w-3.5" />立即执行</Button>
      </PageHeaderActions>
      <div className="terminal-page">
      {error && <div className="border border-accent-red-soft bg-accent-red-soft px-3 py-2 text-[11px] leading-4 text-trading-up">{error}</div>}
      {notice && <div className="border border-line bg-surface-elevated px-3 py-2 text-[11px] leading-4 text-ink">{notice}</div>}
      {!overview && <LoadingPanel label="页面已就绪，正在后台连接同花顺模拟账户…" />}
      {overview && account && plan && (
      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-3">
          <section className="panel"><div className="overflow-auto"><table className="data-table min-w-[920px]"><thead><tr><th className="sticky left-0 z-[11] bg-surface-elevated">名称</th><th>代码</th><th>入场日</th><th className="text-right">交易日</th><th className="text-right">持仓</th><th className="text-right">可卖</th><th className="text-right">成本</th><th className="text-right">现价</th><th className="text-right">盈亏额</th><th className="text-right">盈亏率</th><th className="text-right">市值</th></tr></thead><tbody>{account.positions.length === 0 ? <tr><td colSpan={11}><EmptyState title={hasAccountSnapshot ? '暂无持仓' : '等待同花顺账户快照'} description={hasAccountSnapshot ? undefined : '页面和策略历史已可查看，账户数据将在后台连接完成后更新。'} /></td></tr> : account.positions.map((position) => <tr key={position.stock_code}><td className="sticky left-0 z-[1] bg-surface-elevated font-semibold text-ink">{position.stock_name}</td><td className="font-mono text-xs text-muted">{position.stock_code}</td><td className="font-mono text-xs text-muted">{position.entry_date || '—'}</td><td className="text-right font-mono text-xs">{position.hold_days ?? '—'}</td><td className="text-right font-mono text-xs">{position.shares.toLocaleString()}</td><td className="text-right font-mono text-xs">{position.available_shares.toLocaleString()}</td><td className="text-right font-mono text-xs">{position.cost_price.toFixed(2)}</td><td className="text-right font-mono text-xs">{position.current_price.toFixed(2)}</td><td className={`text-right font-mono text-xs ${pctColor(position.pnl_amount)}`}>{position.pnl_amount > 0 ? '+' : ''}{formatMoney(position.pnl_amount)}</td><td className={`text-right font-mono text-xs ${pctColor(position.pnl_pct)}`}>{position.pnl_pct > 0 ? '+' : ''}{position.pnl_pct.toFixed(2)}%</td><td className="text-right font-mono text-xs text-ink">{formatMoney(position.market_value)}</td></tr>)}</tbody></table></div></section>

          <section className="panel overflow-hidden">
            <div className="flex border-b border-line">
              <button className={tabStyle(planTab === 'pending')} onClick={() => { setPlanTab('pending'); setHistoryPage(1); }}>
                待执行{plan.orders.length > 0 && <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-on-primary">{plan.orders.length}</span>}
              </button>
              <button className={tabStyle(planTab === 'executed')} onClick={() => { setPlanTab('executed'); setHistoryPage(1); }}>
                已执行{executedHistory.length > 0 && <span className="ml-1.5 font-mono text-[10px] text-muted">({executedHistory.length})</span>}
              </button>
              <button className={tabStyle(planTab === 'expired')} onClick={() => { setPlanTab('expired'); setHistoryPage(1); }}>
                过期{expiredHistory.length > 0 && <span className="ml-1.5 font-mono text-[10px] text-muted">({expiredHistory.length})</span>}
              </button>
            </div>
            {planTab === 'pending' ? (
              <div className="overflow-auto">
                <table className="data-table min-w-[1040px]">
                  <thead><tr><th>方向</th><th>状态</th><th>信号日</th><th className="text-right">排名</th><th>窗口</th><th>代码</th><th>名称</th><th className="text-right">数量</th><th className="text-right">参考价</th><th className="text-right">预计金额</th><th>原因</th><th>回查/异常</th></tr></thead>
                  <tbody>{plan.orders.length === 0 ? <tr><td colSpan={12}><EmptyState title="暂无待执行指令" description="当前没有活动指令；交易日收盘后会按排行榜、持仓上限和退出条件生成下一交易日计划。" /></td></tr> : plan.orders.map((order) => <tr key={order.id}><td className={order.side === 'buy' ? 'font-semibold text-trading-up' : 'font-semibold text-trading-down'}>{order.side === 'buy' ? '买入' : '卖出'}</td><td className={`font-mono text-xs ${historyStatusTone(order.status)}`}>{order.status}</td><td className="font-mono text-xs text-muted">{order.signal_date ?? '—'}</td><td className="text-right font-mono text-xs">{order.rank ?? '—'}</td><td className="text-xs text-muted">{order.window}</td><td className="font-mono text-xs text-muted">{order.stock_code}</td><td className="font-semibold text-ink">{order.stock_name}</td><td className="text-right font-mono text-xs">{order.quantity.toLocaleString()}</td><td className="text-right font-mono text-xs">{order.price.toFixed(2)}</td><td className="text-right font-mono text-xs">{formatMoney(order.amount)}</td><td className="max-w-xs whitespace-normal text-xs text-muted">{order.reason}</td><td className="max-w-sm whitespace-normal text-xs text-trading-up">{order.broker_status ?? '—'}</td></tr>)}</tbody>
                </table>
                {plan.skipped.length > 0 && <div className="border-t border-primary/30 bg-primary/5 px-3 py-2 text-[11px] leading-4 text-primary-active">{plan.skipped.join(' ')}</div>}
              </div>
            ) : planTab === 'executed' ? (
              <PlanHistoryTable history={executedHistory} page={historyPage} pageSize={HISTORY_PAGE_SIZE} onPage={setHistoryPage} />
            ) : (
              <PlanHistoryTable
                history={expiredHistory}
                page={historyPage}
                pageSize={HISTORY_PAGE_SIZE}
                onPage={setHistoryPage}
                emptyTitle="暂无过期计划"
                emptyDescription="计划仅在信号日后的首个交易日有效；当日收盘仍未执行时会自动归入这里。"
              />
            )}
          </section>

          <section><SectionHeading title="当日委托" /><div className="table-scroll"><table className="data-table min-w-[720px]"><thead><tr><th>方向</th><th>代码</th><th>名称</th><th className="text-right">委托价</th><th className="text-right">委托量</th><th>状态</th><th>窗口</th></tr></thead><tbody>{account.orders.length === 0 ? <tr><td colSpan={7}><EmptyState title="暂无委托记录" /></td></tr> : account.orders.map((order) => <tr key={order.id}><td className={order.side === 'buy' ? 'font-semibold text-trading-up' : 'font-semibold text-trading-down'}>{order.side === 'buy' ? '买入' : '卖出'}</td><td className="font-mono text-xs text-muted">{order.stock_code}</td><td className="font-semibold text-ink">{order.stock_name}</td><td className="text-right font-mono text-xs">{order.price.toFixed(2)}</td><td className="text-right font-mono text-xs">{order.quantity.toLocaleString()}</td><td className="text-xs text-muted">{order.status}</td><td className="text-xs text-muted">{order.window}</td></tr>)}</tbody></table></div></section>
        </div>

        <aside className="space-y-3">
          <section className="panel overflow-hidden"><div className="module-header"><h2 className="font-display text-base text-ink">账户</h2><span className={`font-mono text-sm font-semibold ${hasAccountSnapshot ? 'text-ink' : 'text-muted'}`}>{hasAccountSnapshot ? formatMoney(account.total_assets) : '—'}</span></div><div className="border-b border-line-soft px-3 pb-2.5 pt-3"><MiniEquityChart points={overview.asset_history ?? []} /></div><div className="divide-y divide-line-soft">{[
            ['可用资金', hasAccountSnapshot ? formatMoney(account.available_cash) : '—', 'text-ink'],
            ['持仓盈亏', hasAccountSnapshot ? formatMoney(account.pnl_summary.amount) : '—', hasAccountSnapshot ? pctColor(account.pnl_summary.amount) : 'text-muted'],
            ['盈亏率', hasAccountSnapshot ? `${account.pnl_summary.pct >= 0 ? '+' : ''}${account.pnl_summary.pct.toFixed(2)}%` : '—', hasAccountSnapshot ? pctColor(account.pnl_summary.pct) : 'text-muted'],
            ['当前仓位', hasAccountSnapshot ? `${account.current_position_pct.toFixed(1)}%` : '—', 'text-ink'],
          ].map(([label, value, valueClass]) => <div key={label} className="flex items-center justify-between gap-3 px-3 py-2.5"><span className="text-[11px] text-muted">{label}</span><span className={`font-mono text-[11px] ${valueClass}`}>{value}</span></div>)}</div></section>

          <section className="panel overflow-hidden"><div className="module-header"><h2 className="font-display text-base text-ink">策略</h2></div><table className="data-table"><tbody>{[
            ['资金使用上限', `${plan.target_position_pct}%`],
            ['单票仓位', `${plan.position_size_pct}%`],
            ['持仓上限', `${plan.max_positions} 只`],
            ['市场情绪', plan.sentiment === 'hot' ? '热' : plan.sentiment === 'normal' ? '中性' : '冷'],
            ['策略日期', plan.ranking_date]
          ].map(([label, value]) => <tr key={label}><td className="text-muted">{label}</td><td className="text-right font-mono text-ink">{value}</td></tr>)}</tbody></table></section>

          <section className="panel p-3.5"><h2 className="font-display text-base text-ink">风控</h2><div className="mt-3 space-y-2">{[['成交时序', '行情好买开盘 / 卖临收盘；行情弱相反'], ['单票上限', `基准资金 ${plan.position_size_pct}%`], ['持仓上限', `${plan.max_positions} 只`], ['每日新增', `≤ ${plan.max_entries_per_day} 只`], ['退出规则', `${plan.stop_loss_pct}% / +${plan.take_profit_pct}% / ${plan.max_hold_days}d`]].map(([label, detail]) => <div key={label} className="flex items-center justify-between border-b border-line-soft pb-1.5 text-[11px] last:border-0 last:pb-0"><span className="text-muted">{label}</span><span className="font-mono text-ink">{detail}</span></div>)}</div></section>
        </aside>
      </section>
      )}

      <Modal open={executeOpen} onClose={() => setExecuteOpen(false)} title={selectedWindow === 'auto' ? '确认立即执行' : selectedWindow === 'close' ? '确认运行决策' : '确认运行盘后核对'} description={selectedWindow === 'auto' ? '系统将根据当前时间自动判断并执行对应窗口（开盘/临收盘/收盘决策/盘后核对）。' : selectedWindow === 'close' ? '系统将刷新最新行情并生成交易计划，可随时运行；收盘后的自动决策机制仍会按原计划执行。' : 'Node.js 交易核心会运行所选策略窗口；AppleScript 仅查询和操作同花顺"模拟练习"。'}>
        <div className="space-y-3"><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setExecuteOpen(false)}>取消</Button><Button variant="danger" disabled={busy} onClick={() => void execute()}>确认执行</Button></div></div>
      </Modal>

      <Modal
        open={backtestHistoryOpen}
        onClose={closeBacktestHistory}
        title="回测历史"
        description="选择一条回测记录，将其策略参数应用到模拟交易。"
        width="max-w-4xl"
      >
        {backtestHistoryLoading ? (
          <LoadingPanel label="正在读取回测历史…" />
        ) : (
          <div className="table-scroll border border-line">
            <table className="data-table min-w-[820px]">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>时间</th>
                  <th>周期</th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleBacktestSort('total_return_pct')}>
                    收益率
                    {backtestSortColumn === 'total_return_pct' ? (backtestSortDirection === 'asc' ? <ArrowUp className="ml-0.5 inline-block h-3 w-3" /> : <ArrowDown className="ml-0.5 inline-block h-3 w-3" />) : null}
                  </th>
                  <th className="cursor-pointer select-none text-right" onClick={() => toggleBacktestSort('win_rate')}>
                    胜率
                    {backtestSortColumn === 'win_rate' ? (backtestSortDirection === 'asc' ? <ArrowUp className="ml-0.5 inline-block h-3 w-3" /> : <ArrowDown className="ml-0.5 inline-block h-3 w-3" />) : null}
                  </th>
                  <th className="text-right">交易</th>
                  <th>参数</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {backtestHistory.length === 0 ? (
                  <tr><td colSpan={8}><EmptyState title="暂无回测记录" description="请先在回测页运行一次策略回测。" /></td></tr>
                ) : paginatedBacktestHistory.items.map((item) => (
                  <tr key={item.run_id}>
                    <td className="font-mono text-[11px] text-ink">{historyItemTitle(item)}</td>
                    <td className="font-mono text-[11px] text-muted">{item.timestamp}</td>
                    <td className="font-mono text-[11px] text-muted">{item.date_range}</td>
                    <td className={`text-right font-mono text-[11px] ${pctColor(item.total_return_pct)}`}>{item.total_return_pct > 0 ? '+' : ''}{item.total_return_pct.toFixed(2)}%</td>
                    <td className={`text-right font-mono text-[11px] ${pctColor(item.win_rate - 50)}`}>{item.win_rate.toFixed(1)}%</td>
                    <td className="text-right font-mono text-[11px] text-muted">{item.total_trades}</td>
                    <td className="font-mono text-[11px] text-muted">{[item.position_size_pct ? `${item.position_size_pct}%` : null, item.max_positions ? `${item.max_positions}只` : null, item.max_hold_days ? `${item.max_hold_days}天` : null].filter(Boolean).join(' ')}</td>
                    <td className="w-24">
                      <Button
                        variant="secondary"
                        className="h-7 px-2 text-[11px]"
                        disabled={Boolean(applyingBacktestRunId)}
                        onClick={() => void applyBacktestParams(item.run_id)}
                      >
                        {applyingBacktestRunId === item.run_id ? '应用中' : '应用'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {paginatedBacktestHistory.totalPages > 1 ? (
              <Pagination page={paginatedBacktestHistory.page} pages={paginatedBacktestHistory.totalPages} onPage={setBacktestHistoryPage} />
            ) : null}
          </div>
        )}
      </Modal>
      </div>
    </>
  );
}
