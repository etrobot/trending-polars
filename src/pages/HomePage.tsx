import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownUp,
  Flame,
  Gauge,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { StatePill, StrategyPill, SentimentPill } from '../components/Pills';
import { PageHeaderActions } from '../components/HeaderActions';
import { Button, EmptyState, LoadingPanel, MetricCard } from '../components/Ui';
import { useTaskResult, useTasks } from '../context/TasksContext';
import { api, pctColor, sentimentLabel } from '../lib/api';
import type { AnalysisData, BlockAnalysis, IndexAnalysis, TaskSnapshot } from '../types';

type BlockSort = 'name' | 'limit_up_num' | 'change' | 'state_id' | 'position';

function compareBlocks(a: BlockAnalysis, b: BlockAnalysis, key: BlockSort) {
  const values: Record<BlockSort, [string | number, string | number]> = {
    name: [a.name, b.name],
    limit_up_num: [a.block_info.limit_up_num, b.block_info.limit_up_num],
    change: [a.block_info.change, b.block_info.change],
    state_id: [a.trend.state_id, b.trend.state_id],
    position: [a.strategy.position, b.strategy.position],
  };
  const [left, right] = values[key];
  return typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN');
}

export function HomePage() {
  const navigate = useNavigate();
  const { setPanelOpen } = useTasks();
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTaskId, setRefreshTaskId] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: BlockSort; desc: boolean }>({ key: 'limit_up_num', desc: true });

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await api<AnalysisData>('/api/analysis'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onRefreshDone = useCallback((task: TaskSnapshot) => {
    setRefreshTaskId(null);
    if (task.status !== 'completed') {
      setRefreshing(false);
      setError(task.message || '行情刷新未完成');
      return;
    }
    void load();
  }, [load]);
  useTaskResult(refreshTaskId, onRefreshDone);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await api<{ task_id: string }>('/api/analysis?refresh=1');
      setRefreshTaskId(result.task_id);
      setPanelOpen(true);
    } catch (refreshError) {
      setRefreshing(false);
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  };

  const blocks = useMemo(() => {
    if (!data) return [];
    return [...data.blocks]
      .filter((block) => Number(block.trend.state_id) >= 1 && Number(block.trend.state_id) <= 7)
      .sort((a, b) => compareBlocks(a, b, sort.key) * (sort.desc ? -1 : 1));
  }, [data, sort]);

  const indices = useMemo(() => data?.indices.filter((item) => item.state.state_id >= 1 && item.state.state_id <= 7) ?? [], [data]);

  if (loading) return <><PageHeaderActions><Button disabled><RefreshCw className="h-3.5 w-3.5 animate-spin" />加载中</Button></PageHeaderActions><LoadingPanel label="正在读取指数、板块与市场情绪…" /></>;
  if (!data) return <><PageHeaderActions><Button onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />重新加载</Button></PageHeaderActions><div className="panel"><EmptyState title="市场数据加载失败" description={error || '当前没有可用数据'} /></div></>;

  const toggleSort = (key: BlockSort) => setSort((current) => current.key === key ? { key, desc: !current.desc } : { key, desc: true });
  const SortLabel = ({ field, children }: { field: BlockSort; children: string }) => (
    <button className={`focus-ring inline-flex items-center gap-1 rounded ${sort.key === field ? 'text-primary' : ''}`} onClick={() => toggleSort(field)}>{children}<ArrowDownUp className="h-2.5 w-2.5" /></button>
  );

  return (
    <>
      <PageHeaderActions><Button disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />{refreshing ? '刷新中' : '刷新数据'}</Button></PageHeaderActions>
      <div className="terminal-page">
      {error && <div className="border border-[#6b3434] bg-[#2c1919] px-3 py-2 text-[11px] leading-4 text-trading-up">{error}</div>}
      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="市场情绪" value={<span className="flex items-center gap-2">{sentimentLabel(data.sentiment.sentiment)} <SentimentPill sentiment={data.sentiment.sentiment} /></span>} detail={`${data.sentiment.total_blocks} 个活跃板块`} tone="coral" icon={<Flame className="h-4 w-4" />} />
        <MetricCard label="涨停家数" value={data.sentiment.total_limit_up} detail="全市场" icon={<TrendingUp className="h-4 w-4" />} />
        <MetricCard label="风险指数" value={`${data.stats?.risk_indices ?? 0} / ${indices.length}`} detail="阴跌或恐慌状态" tone="dark" icon={<ShieldAlert className="h-4 w-4" />} />
        <MetricCard label="板块均值" value={`${(data.stats?.average_block_change ?? 0) >= 0 ? '+' : ''}${(data.stats?.average_block_change ?? 0).toFixed(2)}%`} detail={data.timestamp} tone="green" icon={<Gauge className="h-4 w-4" />} />
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0">
          <div className="table-scroll">
            <table className="data-table min-w-[920px]">
              <thead>
                <tr>
                  <th><SortLabel field="name">板块名称</SortLabel></th>
                  <th className="text-center"><SortLabel field="limit_up_num">涨停数</SortLabel></th>
                  <th className="text-right"><SortLabel field="change">日涨幅</SortLabel></th>
                  <th className="text-center"><SortLabel field="state_id">趋势</SortLabel></th>
                  <th className="text-right">距高点</th>
                  <th className="text-center">量能</th>
                  <th className="text-center">策略</th>
                  <th><SortLabel field="position">仓位</SortLabel></th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((block, index) => {
                  const change = Number(block.block_info.change ?? 0);
                  return (
                    <tr key={block.code} className="cursor-pointer" onClick={() => navigate(`/details?code=${block.code}&idx=${index}`)}>
                      <td className="font-semibold text-ink">{block.name}</td>
                      <td className="text-center"><span className="inline-flex min-w-7 justify-center bg-[#2b2417] px-2 py-0.5 font-mono text-[11px] font-semibold text-primary" style={{ borderRadius: 2 }}>{block.block_info.limit_up_num}</span></td>
                      <td className={`text-right font-mono font-semibold ${pctColor(change)}`}>{change > 0 ? '+' : ''}{change.toFixed(2)}%</td>
                      <td className="text-center"><StatePill state={block.trend} /></td>
                      <td className="text-right font-mono text-xs">{block.trend.near_high ?? '—'}</td>
                      <td className="text-center text-xs">{block.trend.volume_trend ?? '—'}</td>
                      <td className="text-center"><StrategyPill action={block.strategy.action} label={block.strategy.label} /></td>
                      <td><span className="font-mono text-xs font-semibold text-primary">{block.strategy.position}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="panel overflow-hidden xl:max-h-[calc(100vh-158px)]">
          <div className="module-header">
            <h2 className="font-display text-base font-semibold text-ink">指数</h2>
            <span className="font-mono text-[11px] text-muted">{indices.length}</span>
          </div>
          <div className="max-h-[calc(100vh-194px)] divide-y divide-line-soft overflow-y-auto">
            {indices.map((item: IndexAnalysis) => (
              <div key={item.code} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate text-[11px] text-ink">{item.name}</div>
                  <StatePill state={item.state} compact />
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="text-muted">{item.code}</span>
                  <span className="text-right text-ink">{Number(item.price).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </section>
      </div>
    </>
  );
}
