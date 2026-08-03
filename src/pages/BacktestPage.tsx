import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CalendarRange,
  Clock3,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { EquityCurve } from '../components/Charts';
import { PageHeaderActions } from '../components/HeaderActions';
import { Modal } from '../components/Modal';
import { Button, EmptyState, LoadingPanel, Pagination, SectionHeading } from '../components/Ui';
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

const HISTORY_PAGE_SIZE = 15;
const MAX_FACTOR_WEIGHT_PCT = 200;

function historyItemTitle(item: BacktestListItem) {
  if (item.mode === 'random' && (item.strategy_count ?? 1) > 1) {
    return `随机组合 ${item.combo_index}/${item.strategy_count}`;
  }
  return item.mode === 'current' ? '当前方案' : '随机组合';
}

interface ScoreStockConfigView {
  distanceFromLow: {
    atLowScore: number;
    extendedScore: number;
    tiers: Array<{ label: string; maxPct: number; score: number }>;
  };
  trend: {
    bullishAlignment: number;
    tangledAlignment: number;
    bearishAlignment: number;
    trendBonusMultiplier: number;
    trendBonusCap: number;
  };
}

const DEFAULT_SCORE_STOCK_CONFIG: ScoreStockConfigView = {
  distanceFromLow: {
    atLowScore: 2,
    extendedScore: 8,
    tiers: [
      { label: '贴近低点', maxPct: 5, score: 4 },
      { label: '刚离低点', maxPct: 15, score: 10 },
      { label: '启动确认', maxPct: 30, score: 18 },
      { label: '趋势上行', maxPct: 50, score: 20 },
      { label: '远离低点', maxPct: 80, score: 14 },
    ],
  },
  trend: {
    bullishAlignment: 28,
    tangledAlignment: 14,
    bearishAlignment: 0,
    trendBonusMultiplier: 400,
    trendBonusCap: 12,
  },
};

function isScoreStockConfigView(value: unknown): value is ScoreStockConfigView {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as ScoreStockConfigView;
  return Array.isArray(candidate.distanceFromLow?.tiers) && Boolean(candidate.trend);
}

function parseScoringConfig(value: unknown): ScoreStockConfigView | null {
  if (typeof value !== 'string') return isScoreStockConfigView(value) ? value : null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isScoreStockConfigView(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveScoringConfig(result: BacktestResult | null, applied: unknown): ScoreStockConfigView {
  // 展示已完成回测实际使用的配置，不能拿“最近一次优化结果”冒充当前结果。
  const persisted = parseScoringConfig(result?.config?.scoring_config_json);
  if (persisted) return persisted;
  if (result) return DEFAULT_SCORE_STOCK_CONFIG;
  if (isScoreStockConfigView(applied)) return applied;
  return DEFAULT_SCORE_STOCK_CONFIG;
}

function formatScorePts(value: number | undefined | null) {
  return value == null || Number.isNaN(value) ? '-' : `${value} 分`;
}

function safeFixed(value: number | undefined | null, digits: number): string {
  if (value == null || Number.isNaN(value)) return '-';
  return value.toFixed(digits);
}

function safeSignedFixed(value: number | undefined | null, digits: number): string {
  if (value == null || Number.isNaN(value)) return '-';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function configNumberValue(config: Record<string, number | string | null>, key: string, fallback: number) {
  const value = Number(config[key]);
  return Number.isFinite(value) ? value : fallback;
}

interface OptimizeResult {
  days: number;
  training_as_of_date?: string;
  forward_days?: number;
  scoring: {
    config: ScoreStockConfigView;
    scoreCorrelation: number;
    topBottomSpreadPct: number;
    distanceBucketStats: Array<{
      label: string;
      minPct: number;
      maxPct: number | null;
      sampleCount: number;
      avgForwardReturnPct: number;
      winRatePct: number;
      positionScore: number;
    }>;
    sweetSpotLabels: string[];
  };
  optimized: {
    maxHoldDays: number;
    maxPositions: number;
    positionSizePct: number;
    takeProfitPct: number;
    stopLossPct: number;
    trendWeightPct: number;
    volumePriceWeightPct: number;
    distanceFromLowWeightPct: number;
    volatilityWeightPct: number;
    relativeStrengthWeightPct?: number;
  };
  validation: {
    totalReturnPct: number;
    winRate: number;
    maxDrawdownPct: number;
    totalTrades: number;
  };
  baseline: {
    params: OptimizeResult['optimized'];
    validation: OptimizeResult['validation'];
  };
  beatBaseline: boolean;
  methodology: string;
  message?: string;
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
  const [optimizeTaskId, setOptimizeTaskId] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<OptimizeResult | null>(null);
  const [appliedScoringConfig, setAppliedScoringConfig] = useState<ScoreStockConfigView | null>(null);
  const [days, setDays] = useState(60);
  const [optimizationDays, setOptimizationDays] = useState(40);
  const [strategyCount, setStrategyCount] = useState(3);
  const [positionSizePct, setPositionSizePct] = useState(20);
  const [maxPositions, setMaxPositions] = useState(5);
  const [maxHoldDays, setMaxHoldDays] = useState(7);
  const [takeProfitPct, setTakeProfitPct] = useState(20);
  const [stopLossPct, setStopLossPct] = useState(15);
  const [trendWeightPct, setTrendWeightPct] = useState(100);
  const [volumePriceWeightPct, setVolumePriceWeightPct] = useState(100);
  const [distanceFromLowWeightPct, setDistanceFromLowWeightPct] = useState(100);
  const [volatilityWeightPct, setVolatilityWeightPct] = useState(100);
  const [relativeStrengthWeightPct, setRelativeStrengthWeightPct] = useState(100);
  const [sortColumn, setSortColumn] = useState<'win_rate' | 'total_return_pct' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [historyPage, setHistoryPage] = useState(1);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());

  const sortedHistory = useMemo(() => {
    if (!sortColumn) return history;
    return [...history].sort((a, b) => {
      const valA = a[sortColumn];
      const valB = b[sortColumn];
      return sortDirection === 'asc' ? valA - valB : valB - valA;
    });
  }, [history, sortColumn, sortDirection]);

  const paginatedHistory = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(sortedHistory.length / HISTORY_PAGE_SIZE));
    const safePage = Math.min(historyPage, totalPages);
    const offset = (safePage - 1) * HISTORY_PAGE_SIZE;
    return {
      items: sortedHistory.slice(offset, offset + HISTORY_PAGE_SIZE),
      page: safePage,
      totalPages,
    };
  }, [sortedHistory, historyPage]);

  const toggleSort = (column: 'win_rate' | 'total_return_pct') => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  };

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

  // 从服务端文件加载已持久化的优化结果
  useEffect(() => {
    api<OptimizeResult | null>('/api/backtest/optimize-result')
      .then((result) => { if (result) setOptimizeResult(result); })
      .catch(() => { /* 无历史优化结果，忽略 */ });
  }, []);

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

  const onOptimizeDone = useCallback((task: TaskSnapshot) => {
    setOptimizeTaskId(null);
    setOptimizing(false);
    if (task.status !== 'completed') {
      setError(task.message || '参数优化未完成');
      return;
    }
    void (async () => {
      const detail = await api<TaskSnapshot>(`/api/tasks/${task.id}`);
      const payload = detail.result as OptimizeResult | undefined;
      if (!payload?.optimized) {
        setError('参数优化结果为空');
        return;
      }
      console.log('[backtest] optimize completed', payload);
      setOptimizeResult(payload);
      setOptimizeOpen(true);
      setError('');
      setNotice(payload.message ?? (payload.beatBaseline ? '参数优化完成，结果超越默认基线' : '优化未超越默认方案，已回退默认参数'));
    })().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, []);
  useTaskResult(optimizeTaskId, onOptimizeDone);

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
        trend_weight_pct: String(trendWeightPct),
        volume_price_weight_pct: String(volumePriceWeightPct),
        distance_from_low_weight_pct: String(distanceFromLowWeightPct),
        volatility_weight_pct: String(volatilityWeightPct),
        relative_strength_weight_pct: String(relativeStrengthWeightPct),
      });
      // 优化结果只在用户点击“应用”后才进入回测；否则手动回测会被
      // 页面上一次持久化的优化配置静默污染。
      const scoringConfigApplied = appliedScoringConfig;
      if (scoringConfigApplied) {
        params.set('scoring_config', JSON.stringify(scoringConfigApplied));
      }
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

  const optimize = async () => {
    setOptimizing(true);
    setError('');
    setNotice('');
    console.log('[backtest] start optimize', { optimizationDays, simulationDays: days });
    const response = await api<{ task_id: string }>(`/api/backtest/optimize?days=${optimizationDays}&simulation_days=${days}`, { method: 'POST' });
    setOptimizeTaskId(response.task_id);
    setPanelOpen(true);
  };

  const onOptimizeClick = () => {
    void optimize().catch((optimizeError) => {
      setOptimizing(false);
      setError(optimizeError instanceof Error ? optimizeError.message : String(optimizeError));
    });
  };

  const applyOptimizedParams = () => {
    if (!optimizeResult) return;
    const params = optimizeResult.optimized;
    setMaxHoldDays(params.maxHoldDays);
    setMaxPositions(params.maxPositions);
    setPositionSizePct(params.positionSizePct);
    setTakeProfitPct(params.takeProfitPct);
    setStopLossPct(params.stopLossPct);
    setTrendWeightPct(params.trendWeightPct);
    setVolumePriceWeightPct(params.volumePriceWeightPct);
    setDistanceFromLowWeightPct(params.distanceFromLowWeightPct);
    setVolatilityWeightPct(params.volatilityWeightPct);
    setRelativeStrengthWeightPct(params.relativeStrengthWeightPct ?? 100);
    setAppliedScoringConfig(optimizeResult.scoring.config);
    setOptimizeOpen(false);
    setSettingsOpen(true);
    setAppliedMessage('已应用优化参数，可点击「回测当前方案」验证');
    setNotice('已应用优化参数，可运行「回测当前方案」验证');
  };

  const openSettingsWithDisplayedScheme = () => {
    if (!result) return;
    const config = result.config;
    console.log('[backtest] open settings with displayed scheme', { run_id: result.run_id, config });
    setDays(configNumberValue(config, 'days', days));
    setStrategyCount(configNumberValue(config, 'strategy_count', strategyCount));
    setPositionSizePct(configNumberValue(config, 'position_size_pct', positionSizePct));
    setMaxPositions(configNumberValue(config, 'max_positions', maxPositions));
    setMaxHoldDays(configNumberValue(config, 'max_hold_days', maxHoldDays));
    setTakeProfitPct(configNumberValue(config, 'take_profit_pct', takeProfitPct));
    setStopLossPct(Math.abs(configNumberValue(config, 'stop_loss_pct', stopLossPct)));
    setTrendWeightPct(configNumberValue(config, 'trend_weight_pct', trendWeightPct));
    setVolumePriceWeightPct(configNumberValue(config, 'volume_price_weight_pct', volumePriceWeightPct));
    setDistanceFromLowWeightPct(configNumberValue(config, 'distance_from_low_weight_pct', distanceFromLowWeightPct));
    setVolatilityWeightPct(configNumberValue(config, 'volatility_weight_pct', volatilityWeightPct));
    setRelativeStrengthWeightPct(configNumberValue(config, 'relative_strength_weight_pct', relativeStrengthWeightPct));
    setAppliedScoringConfig(parseScoringConfig(config.scoring_config_json));
    setSettingsOpen(true);
    setAppliedMessage('已加载当前展示方案，可修改参数后重新回测');
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
    setSelectedRunIds((prev) => {
      if (!prev.has(runId)) return prev;
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
    if (result?.run_id === runId) setResult(null);
  };

  const toggleSelectRun = (runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const toggleSelectPage = () => {
    const pageIds = paginatedHistory.items.map((item) => item.run_id);
    const allSelected = pageIds.length > 0 && pageIds.every((runId) => selectedRunIds.has(runId));
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (allSelected) pageIds.forEach((runId) => next.delete(runId));
      else pageIds.forEach((runId) => next.add(runId));
      return next;
    });
  };

  const deleteSelectedRuns = async () => {
    if (selectedRunIds.size === 0) return;
    if (!window.confirm(`确定删除选中的 ${selectedRunIds.size} 条回测记录吗？`)) return;
    const runIds = [...selectedRunIds];
    console.log('[backtest] batch delete', runIds);
    await Promise.all(runIds.map((runId) => api(`/api/backtest/${runId}`, { method: 'DELETE' })));
    const deleted = new Set(runIds);
    setHistory((items) => items.filter((item) => !deleted.has(item.run_id)));
    if (result && deleted.has(result.run_id)) setResult(null);
    setSelectedRunIds(new Set());
  };

  const closeHistoryModal = () => {
    setHistoryOpen(false);
    setSelectedRunIds(new Set());
    setHistoryPage(1);
  };

  const curve = useMemo(() => result ? curveFromTrades(result) : [], [result]);
  const resultDays = Number(result?.config.days ?? days);
  const configNumber = (key: string) => Number(result?.config?.[key] ?? 0);
  const displayScoringConfig = useMemo(
    () => resolveScoringConfig(result, appliedScoringConfig),
    [result, appliedScoringConfig],
  );

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
    <Button variant="secondary" onClick={openHistory} className="whitespace-nowrap"><Clock3 className="h-3.5 w-3.5" />历史记录{history.length ? ` (${history.length})` : ''}</Button>
    <Button variant="ghost" disabled={loading} onClick={() => void loadHistory()} className="whitespace-nowrap"><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
    <Button variant="primary" disabled={running} onClick={() => setSettingsOpen(true)} className="whitespace-nowrap"><Play className="h-3.5 w-3.5" />{running ? '回测进行中' : '运行回测'}</Button>
  </>;

  const pageRunIds = paginatedHistory.items.map((item) => item.run_id);
  const pageAllSelected = pageRunIds.length > 0 && pageRunIds.every((runId) => selectedRunIds.has(runId));
  const pageSomeSelected = pageRunIds.some((runId) => selectedRunIds.has(runId));

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
        <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px_540px]">
          <div className="panel min-w-0 p-3.5">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2 border-b border-line pb-2"><h2 className="font-display text-base text-ink">回测走势（{resultDays}天）</h2><div className="font-mono text-[11px] text-muted">{result.date_range}</div></div>
            <EquityCurve data={curve} benchmark={benchmark ?? undefined} />
          </div>

          <section className="panel min-w-0 overflow-hidden">
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
              ].map(([label, value, valueClass]) => <div key={label} className="flex items-center justify-between gap-2 px-2.5 py-2"><span className="text-[11px] text-muted">{label}</span><span className={`font-mono text-[11px] ${valueClass}`}>{value}</span></div>)}
            </div>
          </section>

          <section className="panel flex min-w-0 flex-col p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base text-ink">参数</h2>
              <Button variant="secondary" onClick={openSettingsWithDisplayedScheme}>
                <SlidersHorizontal className="h-3.5 w-3.5" />
                用当前方案打开回测设置
              </Button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-x-3 gap-y-0">
              <div>
                <h3 className="mb-1.5 font-mono text-[11px] text-ink font-semibold">策略参数</h3>
                <div className="space-y-1">
                  {[
                    ['回测天数', `${result.config.days} 天`],
                    ['组合序号', `#${result.config.combo_index}`],
                    ['策略数', `${result.config.strategy_count} 组`],
                    ['初始资金', formatMoney(result.summary.initial_capital)],
                    ['仓位', `${configNumber('position_size_pct')}%`],
                    ['持仓个数', `${configNumber('max_positions')} 只`],
                    ['持有天数', `${configNumber('max_hold_days')} 天`],
                    ['止盈', `+${configNumber('take_profit_pct')}%`],
                    ['止损', `${configNumber('stop_loss_pct')}%`],
                    ['日增上限', `≤${configNumber('max_positions_per_day')} 只`],
                    ['候选池', `前${configNumber('max_candidates')} 名`],
                    ['滑点', `${configNumber('slippage_bps')} bps`],
                  ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-1 font-mono text-[11px]"><span className="text-muted">{label}</span><span className="text-right text-ink">{value}</span></div>)}
                </div>
              </div>
              <div>
                <h3 className="mb-1.5 font-mono text-[11px] text-ink font-semibold">因子权重</h3>
                <div className="space-y-1">
                  {[
                    ['趋势', `${configNumber('trend_weight_pct')}%`],
                    ['价量', `${configNumber('volume_price_weight_pct')}%`],
                    ['距低点', `${configNumber('distance_from_low_weight_pct')}%`],
                    ['波动', `${configNumber('volatility_weight_pct')}%`],
                    ['相对强度', `${configNumber('relative_strength_weight_pct')}%`],
                  ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-1 font-mono text-[11px]"><span className="text-muted">{label}</span><span className="text-right text-ink">{value}</span></div>)}
                </div>
                <h3 className="mb-1.5 mt-3 font-mono text-[11px] text-ink font-semibold">趋势维度</h3>
                <div className="space-y-1">
                  {[
                    ['多头排列', formatScorePts(displayScoringConfig.trend.bullishAlignment)],
                    ['纠缠', formatScorePts(displayScoringConfig.trend.tangledAlignment)],
                    ['空头排列', formatScorePts(displayScoringConfig.trend.bearishAlignment)],
                    ['强度乘数', String(displayScoringConfig.trend.trendBonusMultiplier)],
                    ['强度上限', formatScorePts(displayScoringConfig.trend.trendBonusCap)],
                  ].map(([label, value]) => <div key={label} className="flex justify-between gap-2 font-mono text-[11px]"><span className="text-muted">{label}</span><span className="text-ink">{value}</span></div>)}
                </div>
              </div>
              <div>
                <h3 className="mb-1.5 font-mono text-[11px] text-ink font-semibold">评分参数</h3>
                <div className="space-y-1">
                  {[
                    ['评分相关性', safeSignedFixed(optimizeResult?.scoring?.scoreCorrelation, 3)],
                    ['Top-Bottom 收益差', optimizeResult?.scoring?.topBottomSpreadPct != null ? `${safeSignedFixed(optimizeResult.scoring.topBottomSpreadPct, 2)}%` : '-'],
                    ['优选区间', optimizeResult?.scoring.sweetSpotLabels.length ? optimizeResult.scoring.sweetSpotLabels.join('、') : '-'],
                  ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-1 font-mono text-[11px]"><span className="text-muted">{label}</span><span className="text-right text-ink">{value}</span></div>)}
                </div>
                <h3 className="mb-1.5 mt-3 font-mono text-[11px] text-ink font-semibold">距60日低点分档</h3>
                <div className="space-y-1">
                  <div className="flex justify-between gap-2 font-mono text-[11px]"><span className="text-muted">贴合低点</span><span className="text-ink">{formatScorePts(displayScoringConfig.distanceFromLow.atLowScore)}</span></div>
                  {displayScoringConfig.distanceFromLow.tiers.map((tier) => (
                    <div key={tier.label} className="flex justify-between gap-2 font-mono text-[11px]"><span className="text-muted">{tier.label} &lt;{tier.maxPct}%</span><span className="text-ink">{formatScorePts(tier.score)}</span></div>
                  ))}
                  <div className="flex justify-between gap-2 font-mono text-[11px]"><span className="text-muted">高位延伸</span><span className="text-ink">{formatScorePts(displayScoringConfig.distanceFromLow.extendedScore)}</span></div>
                </div>
              </div>
            </div>
            <div className="mt-auto flex items-center gap-2 font-mono text-[11px] text-muted"><CalendarRange className="h-3 w-3" />{result.timestamp}</div>
          </section>
        </section>

        <section>
          <SectionHeading title="交易记录" description={`${result.trades.length} 条`} />
          <div className="table-scroll"><table className="data-table min-w-[1040px]"><thead><tr><th>日期</th><th>代码</th><th>名称</th><th className="text-center">操作</th><th className="text-right">价格</th><th className="text-right">数量</th><th className="text-right">金额</th><th className="text-right">仓位</th><th className="text-right">持仓日</th><th className="text-right">盈亏</th><th>原因</th></tr></thead><tbody>{result.trades.map((trade, index) => <tr key={`${trade.date}-${trade.stock_code}-${index}`}><td className="font-mono text-xs">{trade.date}</td><td className="font-mono text-xs text-muted">{trade.stock_code}</td><td className="font-semibold text-ink">{trade.stock_name}</td><td className={`text-center text-xs ${tradeAction(trade.action)}`}>{trade.action}</td><td className="text-right font-mono text-xs">{trade.price.toFixed(2)}</td><td className="text-right font-mono text-xs">{trade.shares.toLocaleString()}</td><td className="text-right font-mono text-xs">{formatMoney(trade.amount)}</td><td className="text-right font-mono text-xs">{trade.position_pct.toFixed(1)}%</td><td className="text-right font-mono text-xs">{trade.hold_days}</td><td className={`text-right font-mono text-xs ${trade.pnl_pct > 0 ? 'text-trading-up' : trade.pnl_pct < 0 ? 'text-trading-down' : 'text-muted'}`}>{trade.pnl_pct > 0 ? '+' : ''}{trade.pnl_pct.toFixed(2)}%</td><td className="max-w-sm whitespace-normal text-xs text-muted">{trade.reason}</td></tr>)}</tbody></table></div>
        </section>
        </>
      )}

      <Modal open={settingsOpen} onClose={() => { setSettingsOpen(false); setAppliedMessage(''); }} title="回测设置" width="max-w-3xl">
        <div className="space-y-5">
          {appliedMessage ? (
            <div className="mb-4 flex items-start justify-between gap-3 border border-green/55 bg-accent-green-soft px-3 py-2 font-mono text-[11px] text-ink">
              <span>{appliedMessage}</span>
              <button type="button" className="shrink-0 text-muted hover:text-ink" aria-label="关闭通知" onClick={() => setAppliedMessage('')}>✕</button>
            </div>
          ) : null}
          <section className="border border-primary/30 bg-surface-elevated p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="flex items-center gap-2 font-display text-sm text-ink">
                  <SlidersHorizontal className="h-4 w-4 text-primary" />
                  参数优化
                </h3>
                {optimizeResult ? (
                  <p className="mt-2 font-mono text-[11px] text-ink">
                    已有优化结果：评分相关性 {safeSignedFixed(optimizeResult.scoring.scoreCorrelation, 3)}，
                    验证收益 {safeSignedFixed(optimizeResult.validation.totalReturnPct, 2)}%
                  </p>
                ) : (
                  <p className="mt-2 font-mono text-[11px] text-muted">运行优化后，可在此查看并应用最新方案。</p>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <Button variant="primary" disabled={optimizing || running} onClick={onOptimizeClick}>
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {optimizing ? '优化进行中…' : '开始参数优化'}
                </Button>
                {optimizeResult ? (
                  <>
                    <Button variant="secondary" onClick={() => setOptimizeOpen(true)}>
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      最新优化方案
                    </Button>
                    <Button variant="secondary" onClick={applyOptimizedParams}>
                      应用优化结果
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-3 font-display text-sm text-ink">手动回测参数</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className="font-mono text-[11px] text-muted">模拟天数（完整窗口）</span><input type="number" min="10" max="750" step="5" value={days} onChange={(event) => { const nextDays = Number(event.target.value); setDays(nextDays); setOptimizationDays((current) => Math.min(current, Math.max(5, nextDays - 5))); }} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
        <label className="block"><span className="font-mono text-[11px] text-muted">优化天数（从模拟窗口起始日算起）</span><input type="number" min="5" max={Math.max(5, days - 5)} step="5" value={optimizationDays} onChange={(event) => setOptimizationDays(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
        <label className="sm:col-span-3 block"><span className="font-mono text-[11px] text-muted">策略组合个数（固定，仅随机组合使用）</span><input type="number" min="1" max="200" step="1" value={strategyCount} onChange={(event) => setStrategyCount(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">单票仓位（%）（上限）</span><input type="number" min="1" max="100" value={positionSizePct} onChange={(event) => setPositionSizePct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">持仓个数（上限）</span><input type="number" min="1" max="20" value={maxPositions} onChange={(event) => setMaxPositions(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">个股持仓天数（上限）</span><input type="number" min="1" max="60" value={maxHoldDays} onChange={(event) => setMaxHoldDays(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">止盈（%）（上限）</span><input type="number" min="1" max="60" value={takeProfitPct} onChange={(event) => setTakeProfitPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">止损（%）（上限）</span><input type="number" min="1" max="30" value={stopLossPct} onChange={(event) => setStopLossPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">趋势因子权重（%）（上限）</span><input type="number" min="1" max={MAX_FACTOR_WEIGHT_PCT} value={trendWeightPct} onChange={(event) => setTrendWeightPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">价量因子权重（%）（上限）</span><input type="number" min="1" max={MAX_FACTOR_WEIGHT_PCT} value={volumePriceWeightPct} onChange={(event) => setVolumePriceWeightPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">距60日低点权重（%）（上限）</span><input type="number" min="1" max={MAX_FACTOR_WEIGHT_PCT} value={distanceFromLowWeightPct} onChange={(event) => setDistanceFromLowWeightPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">波动因子权重（%）（上限）</span><input type="number" min="1" max={MAX_FACTOR_WEIGHT_PCT} value={volatilityWeightPct} onChange={(event) => setVolatilityWeightPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
            <label className="block"><span className="font-mono text-[11px] text-muted">相对强度权重（%）（上限）</span><input type="number" min="1" max={MAX_FACTOR_WEIGHT_PCT} value={relativeStrengthWeightPct} onChange={(event) => setRelativeStrengthWeightPct(Number(event.target.value))} className="mt-2 w-full border border-line bg-surface px-3 py-2 font-mono text-[12px] text-ink" /></label>
          </div>
          <div className="mt-3 bg-surface-elevated p-3 text-[11px] leading-4 text-muted">
            模拟窗口共 {days} 个交易日；优化使用其起始的 {optimizationDays} 日，后续 {Math.max(0, days - optimizationDays)} 日用于 forward 验证。优化天数必须小于模拟天数，至少预留 5 个交易日作为样本外窗口。回测当前方案：直接使用上方参数原值跑 1 组结果。回测随机组合：在上限内随机取参，分别跑 {strategyCount} 组独立回测，可在历史记录中逐条查看。
          </div>
          </section>

          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => void collect()}>采集真实历史日线</Button>
            <Button variant="secondary" disabled={running} onClick={() => void run('current')}><Play className="h-3.5 w-3.5" />回测当前方案</Button>
            <Button variant="primary" disabled={running} onClick={() => void run('random')}><Play className="h-3.5 w-3.5" />回测随机组合</Button>
          </div>
        </div>
      </Modal>

      <Modal open={optimizeOpen} onClose={() => setOptimizeOpen(false)} title="参数优化结果" description={optimizeResult?.methodology ?? '两阶段：先优化 scoreStock，再优化回测参数'} width="max-w-3xl">
        {optimizeResult ? (
          <div className="space-y-4">
            <section className="border border-line bg-surface-elevated p-3">
              <h3 className="mb-2 font-display text-sm text-ink">阶段1 · scoreStock 评分参数</h3>
              <div className="mb-2 flex flex-wrap gap-4 font-mono text-[11px] text-muted">
                <span>评分相关性 {safeSignedFixed(optimizeResult.scoring.scoreCorrelation, 3)}</span>
                <span>Top-Bottom 收益差 {safeSignedFixed(optimizeResult.scoring.topBottomSpreadPct, 2)}%</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h4 className="mb-1 font-mono text-[11px] text-muted">距60日低点分档</h4>
                  <div className="space-y-1 font-mono text-[11px]">
                    <div className="flex justify-between gap-2"><span className="text-muted">贴底</span><span className="text-ink">{optimizeResult.scoring.config.distanceFromLow.atLowScore} 分</span></div>
                    {optimizeResult.scoring.config.distanceFromLow.tiers.map((tier) => (
                      <div key={tier.label} className="flex justify-between gap-2"><span className="text-muted">{tier.label} &lt;{tier.maxPct}%</span><span className="text-ink">{tier.score} 分</span></div>
                    ))}
                    <div className="flex justify-between gap-2"><span className="text-muted">高位延伸</span><span className="text-ink">{optimizeResult.scoring.config.distanceFromLow.extendedScore} 分</span></div>
                  </div>
                </div>
                <div>
                  <h4 className="mb-1 font-mono text-[11px] text-muted">趋势维度</h4>
                  <div className="space-y-1 font-mono text-[11px]">
                    {[
                      ['多头排列', `${optimizeResult.scoring.config.trend.bullishAlignment} 分`],
                      ['纠缠', `${optimizeResult.scoring.config.trend.tangledAlignment} 分`],
                      ['空头排列', `${optimizeResult.scoring.config.trend.bearishAlignment} 分`],
                      ['强度乘数', String(optimizeResult.scoring.config.trend.trendBonusMultiplier)],
                      ['强度上限', `${optimizeResult.scoring.config.trend.trendBonusCap} 分`],
                    ].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><span className="text-muted">{label}</span><span className="text-ink">{value}</span></div>)}
                  </div>
                </div>
              </div>
            </section>

            <section className="border border-line bg-surface-elevated p-3">
              <h3 className="mb-2 font-display text-sm text-ink">阶段2 · 回测交易参数</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h4 className="mb-1 font-mono text-[11px] text-muted">推荐策略参数</h4>
                  <div className="space-y-1 font-mono text-[11px]">
                    {[
                      ['持仓天数', `${optimizeResult.optimized.maxHoldDays} 天`],
                      ['持仓个数', `${optimizeResult.optimized.maxPositions} 只`],
                      ['单票仓位', `${optimizeResult.optimized.positionSizePct}%`],
                      ['止盈', `+${optimizeResult.optimized.takeProfitPct}%`],
                      ['止损', `${optimizeResult.optimized.stopLossPct}%`],
                    ].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><span className="text-muted">{label}</span><span className="text-ink">{value}</span></div>)}
                  </div>
                </div>
                <div>
                  <h4 className="mb-1 font-mono text-[11px] text-muted">因子权重</h4>
                  <div className="space-y-1 font-mono text-[11px]">
                    {[
                      ['趋势', `${optimizeResult.optimized.trendWeightPct}%`],
                      ['价量', `${optimizeResult.optimized.volumePriceWeightPct}%`],
                      ['距低点', `${optimizeResult.optimized.distanceFromLowWeightPct}%`],
                      ['波动', `${optimizeResult.optimized.volatilityWeightPct}%`],
                      ['相对强度', `${optimizeResult.optimized.relativeStrengthWeightPct ?? 100}%`],
                    ].map(([label, value]) => <div key={label} className="flex justify-between gap-2"><span className="text-muted">{label}</span><span className="text-ink">{value}</span></div>)}
                  </div>
                </div>
              </div>
            </section>

            <section className="border border-line bg-surface-elevated p-3">
              <h3 className="mb-2 font-mono text-[11px] text-muted">
                {optimizeResult.beatBaseline ? '阶段2 网格验证' : '未超越默认基线，已回退默认参数'}
                （{optimizeResult.days} 日回测）
              </h3>
              <div className="mb-2 flex flex-wrap gap-4 font-mono text-[11px] text-muted">
                <span>默认基线 {safeSignedFixed(optimizeResult.baseline.validation.totalReturnPct, 2)}%</span>
                <span className={optimizeResult.beatBaseline ? 'text-trading-up' : 'text-trading-down'}>
                  优化后 {safeSignedFixed(optimizeResult.validation.totalReturnPct, 2)}%
                </span>
              </div>
              <div className="flex flex-wrap gap-4 font-mono text-[11px]">
                <span className={pctColor(optimizeResult.validation.totalReturnPct)}>收益率 {safeSignedFixed(optimizeResult.validation.totalReturnPct, 2)}%</span>
                <span className="text-ink">胜率 {safeFixed(optimizeResult.validation.winRate, 1)}%</span>
                <span className="text-trading-down">最大回撤 {safeFixed(optimizeResult.validation.maxDrawdownPct, 2)}%</span>
                <span className="text-muted">交易 {optimizeResult.validation.totalTrades} 笔</span>
              </div>
              <p className="mt-2 text-[11px] text-muted">优选距低点区间：{optimizeResult.scoring.sweetSpotLabels.join('、')}</p>
            </section>

            <div className="table-scroll">
              <table className="data-table min-w-[640px]">
                <thead><tr><th>距60日低点区间（样本分布）</th><th className="text-right">样本数</th><th className="text-right">分档得分</th><th className="text-right">平均远期收益</th><th className="text-right">胜率</th></tr></thead>
                <tbody>
                  {optimizeResult.scoring.distanceBucketStats.map((bucket) => (
                    <tr key={bucket.label} className={optimizeResult.scoring.sweetSpotLabels.includes(bucket.label) ? 'bg-surface-elevated' : undefined}>
                      <td className="font-mono text-[11px] text-ink">{bucket.label}{optimizeResult.scoring.sweetSpotLabels.includes(bucket.label) ? ' ★' : ''}</td>
                      <td className="text-right font-mono text-[11px] text-muted">{bucket.sampleCount}</td>
                      <td className="text-right font-mono text-[11px] text-ink">{bucket.positionScore}</td>
                      <td className={`text-right font-mono text-[11px] ${pctColor(bucket.avgForwardReturnPct)}`}>{safeSignedFixed(bucket.avgForwardReturnPct, 2)}%</td>
                      <td className="text-right font-mono text-[11px] text-ink">{safeFixed(bucket.winRatePct, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => setOptimizeOpen(false)}>关闭</Button>
              <Button variant="primary" onClick={applyOptimizedParams}>应用到回测设置</Button>
            </div>
          </div>
        ) : <EmptyState title="暂无优化结果" />}
      </Modal>

      <Modal open={historyOpen} onClose={closeHistoryModal} title="回测历史" description={`共 ${history.length} 条记录。点击表头可排序，勾选后可批量删除。`} width="max-w-4xl">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-muted">
            {selectedRunIds.size > 0 ? `已选 ${selectedRunIds.size} 条` : '勾选条目后可批量删除'}
          </span>
          <Button
            variant="secondary"
            disabled={selectedRunIds.size === 0}
            onClick={() => void deleteSelectedRuns().catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))}
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </Button>
        </div>
        <div className="table-scroll border border-line">
          <table className="data-table min-w-[820px]">
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={pageAllSelected}
                    ref={(input) => {
                      if (input) input.indeterminate = !pageAllSelected && pageSomeSelected;
                    }}
                    onChange={toggleSelectPage}
                    aria-label="全选当前页"
                  />
                </th>
                <th>类型</th>
                <th>时间</th>
                <th>周期</th>
                <th className="cursor-pointer select-none text-right" onClick={() => toggleSort('total_return_pct')}>
                  收益率
                  {sortColumn === 'total_return_pct' ? (sortDirection === 'asc' ? <ArrowUp className="ml-0.5 inline-block h-3 w-3" /> : <ArrowDown className="ml-0.5 inline-block h-3 w-3" />) : null}
                </th>
                <th className="cursor-pointer select-none text-right" onClick={() => toggleSort('win_rate')}>
                  胜率
                  {sortColumn === 'win_rate' ? (sortDirection === 'asc' ? <ArrowUp className="ml-0.5 inline-block h-3 w-3" /> : <ArrowDown className="ml-0.5 inline-block h-3 w-3" />) : null}
                </th>
                <th className="text-right">交易</th>
                <th>参数</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={9}><EmptyState title="暂无历史记录" /></td></tr>
              ) : paginatedHistory.items.map((item) => (
                <tr key={item.run_id} className="cursor-pointer" onClick={() => void loadRun(item.run_id)}>
                  <td className="w-10" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={selectedRunIds.has(item.run_id)}
                      onChange={() => toggleSelectRun(item.run_id)}
                      aria-label={`选择 ${historyItemTitle(item)}`}
                    />
                  </td>
                  <td className="font-mono text-[11px] text-ink">{historyItemTitle(item)}</td>
                  <td className="font-mono text-[11px] text-muted">{item.timestamp}</td>
                  <td className="font-mono text-[11px] text-muted">{item.date_range}</td>
                  <td className={`text-right font-mono text-[11px] ${pctColor(item.total_return_pct)}`}>{item.total_return_pct > 0 ? '+' : ''}{item.total_return_pct.toFixed(2)}%</td>
                  <td className={`text-right font-mono text-[11px] ${pctColor(item.win_rate - 50)}`}>{item.win_rate.toFixed(1)}%</td>
                  <td className="text-right font-mono text-[11px] text-muted">{item.total_trades}</td>
                  <td className="font-mono text-[11px] text-muted">{[item.position_size_pct ? `${item.position_size_pct}%` : null, item.max_positions ? `${item.max_positions}只` : null, item.max_hold_days ? `${item.max_hold_days}天` : null].filter(Boolean).join(' ')}</td>
                  <td className="w-10">
                    <button
                      className="focus-ring border border-transparent p-1 text-muted hover:border-accent-red-soft hover:bg-accent-red-soft hover:text-trading-up"
                      onClick={(event) => { event.stopPropagation(); void deleteRun(item.run_id); }}
                      aria-label="删除回测"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {paginatedHistory.totalPages > 1 ? (
            <Pagination page={paginatedHistory.page} pages={paginatedHistory.totalPages} onPage={setHistoryPage} />
          ) : null}
        </div>
      </Modal>
      </div>
    </>
  );
}
