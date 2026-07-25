import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Calculator,
  Layers3,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trophy,
} from 'lucide-react';
import { PageHeaderActions } from '../components/HeaderActions';
import { Button, EmptyState, LoadingPanel, MetricCard, Pagination } from '../components/Ui';
import { useTaskResult, useTasks } from '../context/TasksContext';
import { api, pctColor } from '../lib/api';
import type { RankingResponse, RankingRow, TaskSnapshot } from '../types';

type SortKey = 'stock_name' | 'sector_name' | 'continue_num' | 'latest_price' | 'latest_change_rate' | 'distance_from_low_pct' | 'total_score' | 'trend_score' | 'momentum_score' | 'volume_score' | 'position_score' | 'volatility_trend_score';

function ScoreBar({ value, max, tone = 'coral' }: { value: number; max: number; tone?: 'coral' | 'green' | 'amber' }) {
  const width = Math.min(100, Math.max(0, value / max * 100));
  const color = tone === 'green' ? 'bg-green' : tone === 'amber' ? 'bg-primary/60' : 'bg-primary';
  return <span className="inline-flex w-12 overflow-hidden bg-line-soft align-middle"><span className={`h-1 ${color}`} style={{ width: `${width}%` }} /></span>;
}

function alignmentLabel(value: string) {
  return ({ bullish: '多头', tangled: '缠绕', bearish: '空头' } as Record<string, string>)[value] ?? value;
}

function alignmentClass(value: string) {
  return value === 'bullish' ? 'text-trading-up' : value === 'bearish' ? 'text-trading-down' : 'text-primary-active';
}

export function RankingPage() {
  const { setPanelOpen } = useTasks();
  const [data, setData] = useState<RankingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sector, setSector] = useState('all');
  const [sort, setSort] = useState<SortKey>('total_score');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [computing, setComputing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setDebouncedSearch(search);
    }, 260);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        page_size: '50',
        search: debouncedSearch,
        sector,
        sort,
        order,
      });
      setData(await api<RankingResponse>(`/api/ranking?${params}`));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
      setComputing(false);
    }
  }, [debouncedSearch, order, page, sector, sort]);
  useEffect(() => { void load(); }, [load]);

  const onTaskDone = useCallback((task: TaskSnapshot) => {
    setTaskId(null);
    if (task.status !== 'completed') {
      setComputing(false);
      setError(task.message || '截面排行计算未完成');
      return;
    }
    void load();
  }, [load]);
  useTaskResult(taskId, onTaskDone);

  const compute = async () => {
    setComputing(true);
    try {
      const result = await api<{ task_id: string }>('/api/ranking/compute', { method: 'POST' });
      setTaskId(result.task_id);
      setPanelOpen(true);
    } catch (computeError) {
      setComputing(false);
      setError(computeError instanceof Error ? computeError.message : String(computeError));
    }
  };

  const toggleSort = (key: SortKey) => {
    setPage(1);
    if (sort === key) setOrder((current) => current === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      setOrder(key === 'stock_name' || key === 'sector_name' ? 'asc' : 'desc');
    }
  };

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.page_size ?? 50)));
  const SortHeader = ({ field, children, align = 'left' }: { field: SortKey; children: string; align?: 'left' | 'center' | 'right' }) => (
    <th className={align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''}>
      <button className={`focus-ring inline-flex items-center gap-1 rounded ${sort === field ? 'text-primary-active' : ''}`} onClick={() => toggleSort(field)}>
        {children}{sort === field ? order === 'desc' ? <ArrowDown className="h-2.5 w-2.5" /> : <ArrowUp className="h-2.5 w-2.5" /> : null}
      </button>
    </th>
  );
  
  return (
    <>
      <PageHeaderActions>
        <Button variant="primary" disabled={computing} onClick={() => void compute()}><Calculator className={`h-3.5 w-3.5 ${computing ? 'animate-spin' : ''}`} />{computing ? '计算中' : '重新计算'}</Button>
        <Button variant="ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      </PageHeaderActions>
      <div className="terminal-page">
      {data && (
        <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="股票池" value={data.total_stocks.toLocaleString('zh-CN')} detail={data.date} icon={<Layers3 className="h-4 w-4" />} />
          <MetricCard label="最高分" value={data.summary.top_score.toFixed(1)} detail="综合评分" tone="coral" icon={<Trophy className="h-4 w-4" />} />
          <MetricCard label="中位数" value={data.summary.median_score.toFixed(1)} detail={`均值 ${data.summary.average_score.toFixed(1)}`} tone="dark" icon={<SlidersHorizontal className="h-4 w-4" />} />
        </section>
      )}

      <section>
        <div className="overflow-hidden border border-line bg-canvas" style={{ borderRadius: 6 }}>
          <div className="grid gap-2 border-b border-line bg-surface p-2.5 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_160px_200px_auto]">
            <label className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" /><input className="terminal-field focus-ring w-full pl-8" placeholder="股票名称、代码或板块" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <select className="terminal-field focus-ring" value={sector} onChange={(event) => { setSector(event.target.value); setPage(1); }}><option value="all">全部板块</option>{data?.sectors.map((item) => <option key={item} value={item}>{item}</option>)}</select>
            <Button variant="secondary" onClick={() => { setSearch(''); setDebouncedSearch(''); setSector('all'); setPage(1); }}>重置筛选</Button>
          </div>

          {loading ? <LoadingPanel label="正在筛选与排序…" /> : error ? <EmptyState title="排行加载失败" description={error} /> : !data?.rankings.length ? <EmptyState title="没有匹配结果" description="调整搜索词或策略筛选条件。" /> : (
            <>
              <div className="overflow-auto bg-canvas">
                <table className="data-table min-w-[1180px]">
                  <thead><tr><SortHeader field="stock_name">股票名称</SortHeader><SortHeader field="sector_name">所属板块</SortHeader><th className="text-center">板块趋势</th><SortHeader field="continue_num" align="center">连板</SortHeader><SortHeader field="latest_price" align="right">现价</SortHeader><SortHeader field="latest_change_rate" align="right">涨跌</SortHeader><SortHeader field="distance_from_low_pct" align="right">距60日低点</SortHeader><SortHeader field="total_score" align="right">综合分</SortHeader><SortHeader field="trend_score" align="right">趋势</SortHeader><SortHeader field="position_score" align="right">低点</SortHeader><SortHeader field="volatility_trend_score" align="right">波动</SortHeader><SortHeader field="volume_score" align="right">价量</SortHeader><th className="text-center">均线</th></tr></thead>
                  <tbody>{data.rankings.map((row: RankingRow) => {
                    const change = Number(row.latest_change_rate ?? 0);
                    const top = Number(row.rank) <= 3;
                    return (
                      <tr key={row.stock_code} className={top ? 'bg-surface' : ''}>
                        <td><div className="font-semibold text-ink">{row.stock_name}</div><div className="mt-0.5 font-mono text-[11px] text-muted">{row.stock_code}</div></td>
                        <td><span className="text-xs">{row.sector_name || '—'}</span></td>
                        <td className="text-center"><span className="text-xs text-muted">{row.sector_trend_name || '—'}</span></td>
                        <td className="text-center font-mono text-xs text-primary-deep">{Number(row.continue_num ?? 0)} 板</td>
                        <td className="text-right font-mono text-xs text-ink">{row.latest_price == null ? '—' : Number(row.latest_price).toFixed(2)}</td>
                        <td className={`text-right font-mono text-xs ${pctColor(change)}`}>{change > 0 ? '+' : ''}{change.toFixed(2)}%</td>
                        <td className={`text-right font-mono text-xs ${pctColor(Number(row.distance_from_low_pct ?? 0))}`}>{Number(row.distance_from_low_pct ?? 0) > 0 ? '+' : ''}{Number(row.distance_from_low_pct ?? 0).toFixed(2)}%</td>
                        <td className="text-right"><span className="font-mono text-sm text-primary-active">{Number(row.total_score).toFixed(1)}</span></td>
                        <td className="text-right"><span className="mr-2 font-mono text-xs">{Number(row.trend_score).toFixed(1)}</span><ScoreBar value={Number(row.trend_score)} max={40} /></td>
                        <td className="text-right"><span className="mr-2 font-mono text-xs">{Number(row.position_score ?? 0).toFixed(1)}</span><ScoreBar value={Number(row.position_score ?? 0)} max={20} /></td>
                        <td className="text-right"><span className="mr-2 font-mono text-xs">{Number(row.volatility_trend_score ?? row.momentum_score ?? 0).toFixed(1)}</span><ScoreBar value={Number(row.volatility_trend_score ?? row.momentum_score ?? 0)} max={15} tone="amber" /></td>
                        <td className="text-right"><span className="mr-2 font-mono text-xs">{Number(row.volume_score ?? row.volume_price_score ?? 0).toFixed(1)}</span><ScoreBar value={Number(row.volume_score ?? row.volume_price_score ?? 0)} max={25} tone="green" /></td>
                        <td className={`text-center text-xs ${alignmentClass(row.alignment)}`}>{alignmentLabel(row.alignment)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
              <Pagination page={data.page} pages={pages} onPage={setPage} />
            </>
          )}
        </div>
      </section>
      </div>
    </>
  );
}
