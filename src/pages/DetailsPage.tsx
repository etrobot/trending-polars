import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Search,
} from 'lucide-react';
import { StatePill, StrategyPill } from '../components/Pills';
import { PageHeaderActions } from '../components/HeaderActions';
import { Sparkline } from '../components/Charts';
import { Button, EmptyState, LoadingPanel, SectionHeading } from '../components/Ui';
import { api, pctColor } from '../lib/api';
import type { AnalysisData, SectorStock, SectorStocksResponse } from '../types';
import { useTasks } from '../context/TasksContext';

type StockSort = 'name' | 'continue_num' | 'change_rate' | 'kline_latest';

export function DetailsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stockQuery, setStockQuery] = useState('');
  const [sort, setSort] = useState<{ key: StockSort; desc: boolean }>({ key: 'continue_num', desc: true });
  const [blockPrices, setBlockPrices] = useState<Array<{ date: string; close: number; ma5: number; ma20: number }>>([]);
  const [sectorStocks, setSectorStocks] = useState<SectorStock[]>([]);
  const [sectorStocksLoading, setSectorStocksLoading] = useState(false);
  const [klineRefreshTaskId, setKlineRefreshTaskId] = useState<string | null>(null);
  const [klineRefreshProgress, setKlineRefreshProgress] = useState<number | null>(null);
  const firedTaskIds = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setData(await api<AnalysisData>('/api/analysis'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const blocks = useMemo(() => data?.blocks.filter((block) => block.trend.state_id >= 1 && block.trend.state_id <= 8) ?? [], [data]);
  const selectedIndex = useMemo(() => {
    const code = params.get('code');
    const byCode = code ? blocks.findIndex((block) => block.code === code) : -1;
    if (byCode >= 0) return byCode;
    const idx = Number(params.get('idx'));
    return Number.isInteger(idx) && idx >= 0 && idx < blocks.length ? idx : 0;
  }, [blocks, params]);
  const block = blocks[selectedIndex];

  useEffect(() => {
    if (!block) {
      setBlockPrices([]);
      return;
    }
    void api<Array<{ date: string; close: number; ma5: number; ma20: number }>>(`/api/block_prices?block_code=${block.code}&period=01&limit=60`)
      .then(setBlockPrices)
      .catch(() => setBlockPrices([]));
  }, [block]);

  // 拉取该板块关联的全部个股（数据库累积去重）
  const fetchSectorStocks = useCallback(async (code: string) => {
    try {
      const res = await api<SectorStocksResponse>(`/api/sector-stocks?sector_code=${code}`);
      setSectorStocks(res.stocks);
    } catch {
      setSectorStocks([]);
    } finally {
      setSectorStocksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!block) {
      setSectorStocks([]);
      return;
    }
    setSectorStocksLoading(true);
    void fetchSectorStocks(block.code);
  }, [block, fetchSectorStocks]);

  // 异步入队刷新该板块个股的 K 线（每个板块仅触发一次）
  useEffect(() => {
    if (!block || firedTaskIds.current.has(block.code)) return;
    firedTaskIds.current.add(block.code);
    void api<{ task_id: string; status: string }>(`/api/sector-stocks/refresh-kline?sector_code=${block.code}`, { method: 'POST' })
      .then((res) => setKlineRefreshTaskId(res.task_id))
      .catch(() => undefined);
  }, [block]);

  // 通过全局任务流追踪 K 线刷新进度；任务结束后重新拉一次列表，让 price_fresh 反映最新 K 线覆盖
  const { tasks } = useTasks();
  useEffect(() => {
    if (!klineRefreshTaskId) return;
    const task = tasks.find((item) => item.id === klineRefreshTaskId);
    if (!task) return;
    if (task.status === 'running' || task.status === 'pending') {
      setKlineRefreshProgress(task.progress);
    } else if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      setKlineRefreshProgress(null);
      setKlineRefreshTaskId(null);
      if (task.status === 'completed' && block) {
        void fetchSectorStocks(block.code);
      }
    }
  }, [klineRefreshTaskId, tasks, block, fetchSectorStocks]);

  const setBlock = (index: number) => {
    const next = blocks[(index + blocks.length) % blocks.length];
    if (next) setParams({ code: next.code, idx: String((index + blocks.length) % blocks.length) });
  };

  const stocks = useMemo(() => {
    if (!sectorStocks.length) return [];
    const needle = stockQuery.trim().toLowerCase();
    return [...sectorStocks]
      .filter((stock) => !needle || `${stock.name}${stock.code}${stock.reason_type ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const left = sort.key === 'name' ? a.name : Number(a[sort.key] ?? 0);
        const right = sort.key === 'name' ? b.name : Number(b[sort.key] ?? 0);
        const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN');
        return result * (sort.desc ? -1 : 1);
      });
  }, [sectorStocks, sort, stockQuery]);

  if (loading) return <><PageHeaderActions><Button variant="ghost" onClick={() => navigate('/')}><ArrowLeft className="h-3.5 w-3.5" />返回总览</Button></PageHeaderActions><LoadingPanel label="正在读取板块详情…" /></>;
  if (error || !data || !block) return <><PageHeaderActions><Button variant="ghost" onClick={() => navigate('/')}><ArrowLeft className="h-3.5 w-3.5" />返回总览</Button></PageHeaderActions><div className="panel"><EmptyState title="板块详情不可用" description={error || '没有找到对应板块'} /></div></>;

  const change = Number(block.block_info.change ?? 0);
  const toggleSort = (key: StockSort) => setSort((current) => current.key === key ? { key, desc: !current.desc } : { key, desc: true });
  const SortButton = ({ field, children }: { field: StockSort; children: string }) => <button className="focus-ring inline-flex items-center gap-1" onClick={() => toggleSort(field)}>{children}<ChevronRight className={`h-3 w-3 transition ${sort.key === field ? 'rotate-90 text-primary-active' : 'text-muted'}`} /></button>;
  const freshCount = sectorStocks.filter((stock) => stock.price_fresh).length;
  const pendingCount = sectorStocks.length - freshCount;
  const allFresh = sectorStocks.length > 0 && pendingCount === 0;
  const renderPriceCell = (stock: typeof sectorStocks[number]) => {
    if (stock.price_fresh && stock.kline_change_rate != null) {
      const rate = Number(stock.kline_change_rate);
      return <span className={`font-mono text-xs ${pctColor(rate)}`}>{rate > 0 ? '+' : ''}{rate.toFixed(2)}%</span>;
    }
    return <span className="font-mono text-[11px] text-muted">待更新</span>;
  };

  return (
    <>
      <PageHeaderActions>
        <Button variant="ghost" onClick={() => navigate('/')}><ArrowLeft className="h-3.5 w-3.5" />返回总览</Button>
        <span className="inline-flex h-7 shrink-0 items-center border border-line bg-surface px-2 font-mono text-[11px] text-muted" style={{ borderRadius: 2 }}>{String(selectedIndex + 1).padStart(2, '0')} / {String(blocks.length).padStart(2, '0')}</span>
        <Button variant="secondary" className="h-7 min-h-7 px-2" disabled={selectedIndex <= 0} onClick={() => setBlock(selectedIndex - 1)} aria-label="上一个板块" title="上一个板块"><ChevronLeft className="h-3.5 w-3.5" /></Button>
        <Button variant="secondary" className="h-7 min-h-7 px-2" disabled={selectedIndex >= blocks.length - 1} onClick={() => setBlock(selectedIndex + 1)} aria-label="下一个板块" title="下一个板块"><ChevronRight className="h-3.5 w-3.5" /></Button>
      </PageHeaderActions>
      <div className="terminal-page animate-enter">
      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-l-[3px] border-l-primary px-3 py-2.5">
          <div className="mr-auto flex min-w-0 items-center gap-2.5"><h1 className="font-display text-base text-ink">{block.name}</h1><span className="font-mono text-[11px] text-muted">{block.code}</span><StatePill state={block.trend} /></div>
          {[
            ['涨停', String(block.block_info.limit_up_num), 'text-primary-deep'],
            ['涨幅', `${change > 0 ? '+' : ''}${change.toFixed(2)}%`, pctColor(change)],
            ['距高', block.trend.near_high ?? '—', 'text-ink'],
            ['量能', block.trend.volume_trend ?? '—', 'text-ink'],
          ].map(([label, value, valueClass]) => <div key={label} className="border-l border-line pl-3"><div className="font-mono text-[11px] text-muted">{label}</div><div className={`mt-0.5 font-mono text-[11px] ${valueClass}`}>{value}</div></div>)}
          {blockPrices.length >= 2 && (
            <div className="border-l border-line pl-3">
              <div className="font-mono text-[11px] text-muted">板块指数 60 日</div>
              <div className="mt-0.5"><Sparkline values={blockPrices.map((price) => price.close)} positive={Number(blockPrices.at(-1)!.close) >= Number(blockPrices[0].close)} /></div>
            </div>
          )}
          <div className="border-l border-line pl-3">
            <div className="font-mono text-[11px] text-muted">仓位</div>
            <div className="mt-0.5 font-mono text-[11px] text-primary-deep">{block.strategy.position}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-elevated px-3 py-2">
          <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted">{block.trend.feature ?? '—'} {block.trend.play ?? ''}</p>
          <StrategyPill action={block.strategy.action} label={block.strategy.label} />
        </div>
      </section>

      <section>
        <SectionHeading title={`板块个股 (${sectorStocks.length})`} action={<div className="flex items-center gap-3">
          {klineRefreshProgress != null ? (
            <span className="font-mono text-[11px] text-muted">更新K线 {klineRefreshProgress}%</span>
          ) : !allFresh && sectorStocks.length > 0 ? (
            <span className="font-mono text-[11px] text-muted">已就绪 {freshCount}/{sectorStocks.length} · 刷新中…</span>
          ) : allFresh ? (
            <span className="font-mono text-[11px] text-primary-deep">已就绪 {freshCount}/{sectorStocks.length}</span>
          ) : null}
          <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" /><input className="terminal-field focus-ring w-52 pl-8" placeholder="搜索名称 / 代码" value={stockQuery} onChange={(event) => setStockQuery(event.target.value)} /></div>
        </div>} />
        <div className="table-scroll">
          <table className="data-table min-w-[760px]">
            <thead><tr><th className="w-16 text-center">#</th><th><SortButton field="name">股票名称</SortButton></th><th className="text-center"><SortButton field="continue_num">连板</SortButton></th><th className="text-right"><SortButton field="kline_latest">最新价</SortButton></th><th className="text-right"><SortButton field="change_rate">涨幅</SortButton></th><th>涨停原因</th></tr></thead>
            <tbody>
              {sectorStocksLoading && stocks.length === 0 ? <tr><td colSpan={6}><EmptyState title="正在载入板块个股…" description="从数据库累积记录中读取。" /></td></tr>
                : stocks.length === 0 ? <tr><td colSpan={6}><EmptyState title="没有匹配个股" description="换一个关键词试试。" /></td></tr> : stocks.map((stock, index) => (
                <tr key={`${stock.code}-${index}`}>
                  <td className="text-center font-mono text-xs text-muted">{String(index + 1).padStart(2, '0')}</td>
                  <td><div className="font-semibold text-ink">{stock.name}</div><div className="mt-0.5 font-mono text-[11px] text-muted">{stock.code}</div></td>
                  <td className="text-center"><span className="bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary-deep" style={{ borderRadius: 2 }}>{stock.continue_num ?? 1} 板</span></td>
                  <td className="text-right font-mono text-xs text-ink">{stock.price_fresh && stock.kline_latest != null ? Number(stock.kline_latest).toFixed(2) : '—'}</td>
                  <td className="text-right">{renderPriceCell(stock)}</td>
                  <td className="max-w-md whitespace-normal"><span className="line-clamp-2 text-xs leading-5 text-body">{stock.reason_type ?? '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </div>
    </>
  );
}
