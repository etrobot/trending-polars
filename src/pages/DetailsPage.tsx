import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Info,
  Search,
} from 'lucide-react';
import { StatePill, StrategyPill } from '../components/Pills';
import { PageHeaderActions } from '../components/HeaderActions';
import { Modal } from '../components/Modal';
import { Sparkline } from '../components/Charts';
import { Button, EmptyState, LoadingPanel, SectionHeading } from '../components/Ui';
import { api, pctColor } from '../lib/api';
import type { AnalysisData, BlockAnalysis, LimitUpStock } from '../types';

type StockSort = 'name' | 'continue_num' | 'change_rate';

export function DetailsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stockQuery, setStockQuery] = useState('');
  const [sort, setSort] = useState<{ key: StockSort; desc: boolean }>({ key: 'continue_num', desc: true });
  const [selectedStock, setSelectedStock] = useState<LimitUpStock | null>(null);
  const [blockPrices, setBlockPrices] = useState<Array<{ date: string; close: number; ma5: number; ma20: number }>>([]);
  const [prices, setPrices] = useState<Array<{ date: string; close: number; ma5: number; ma20: number }>>([]);

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

  const blocks = useMemo(() => data?.blocks.filter((block) => block.trend.state_id >= 1 && block.trend.state_id <= 7) ?? [], [data]);
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

  const setBlock = (index: number) => {
    const next = blocks[(index + blocks.length) % blocks.length];
    if (next) setParams({ code: next.code, idx: String((index + blocks.length) % blocks.length) });
  };

  const stocks = useMemo(() => {
    if (!block) return [];
    const needle = stockQuery.trim().toLowerCase();
    return [...block.stock_list]
      .filter((stock) => !needle || `${stock.name}${stock.code}${stock.reason_type ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        const left = sort.key === 'name' ? a.name : Number(a[sort.key] ?? 0);
        const right = sort.key === 'name' ? b.name : Number(b[sort.key] ?? 0);
        const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), 'zh-CN');
        return result * (sort.desc ? -1 : 1);
      });
  }, [block, sort, stockQuery]);

  useEffect(() => {
    if (!selectedStock) {
      setPrices([]);
      return;
    }
    void api<Array<{ date: string; close: number; ma5: number; ma20: number }>>(`/api/stock_prices?stock_code=${selectedStock.code}&limit=45`)
      .then(setPrices)
      .catch(() => setPrices([]));
  }, [selectedStock]);

  if (loading) return <><PageHeaderActions><Button variant="ghost" onClick={() => navigate('/')}><ArrowLeft className="h-3.5 w-3.5" />返回总览</Button></PageHeaderActions><LoadingPanel label="正在读取板块涨停详情…" /></>;
  if (error || !data || !block) return <><PageHeaderActions><Button variant="ghost" onClick={() => navigate('/')}><ArrowLeft className="h-3.5 w-3.5" />返回总览</Button></PageHeaderActions><div className="panel"><EmptyState title="板块详情不可用" description={error || '没有找到对应板块'} /></div></>;

  const change = Number(block.block_info.change ?? 0);
  const toggleSort = (key: StockSort) => setSort((current) => current.key === key ? { key, desc: !current.desc } : { key, desc: true });
  const SortButton = ({ field, children }: { field: StockSort; children: string }) => <button className="focus-ring inline-flex items-center gap-1" onClick={() => toggleSort(field)}>{children}<ChevronRight className={`h-3 w-3 transition ${sort.key === field ? 'rotate-90 text-primary' : 'text-muted'}`} /></button>;

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
          <div className="mr-auto flex min-w-0 items-center gap-2.5"><h1 className="font-display text-base font-semibold text-ink">{block.name}</h1><span className="font-mono text-[11px] text-muted">{block.code}</span><StatePill state={block.trend} /></div>
          {[
            ['涨停', String(block.block_info.limit_up_num), 'text-primary'],
            ['涨幅', `${change > 0 ? '+' : ''}${change.toFixed(2)}%`, pctColor(change)],
            ['距高', block.trend.near_high ?? '—', 'text-ink'],
            ['量能', block.trend.volume_trend ?? '—', 'text-ink'],
          ].map(([label, value, valueClass]) => <div key={label} className="border-l border-line pl-3"><div className="font-mono text-[11px] text-muted">{label}</div><div className={`mt-0.5 font-mono text-[11px] font-semibold ${valueClass}`}>{value}</div></div>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-elevated px-3 py-2">
          <p className="min-w-0 flex-1 text-[11px] leading-4 text-muted">{block.trend.feature ?? '—'} {block.trend.play ?? ''}</p>
          <div className="flex items-center gap-2 text-[11px] text-muted"><StrategyPill action={block.strategy.action} label={block.strategy.label} /><span className="font-mono text-primary">仓位 {block.strategy.position}</span></div>
        </div>
      </section>

      <section className="panel p-3">
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
          <span className="flex items-center gap-2 font-semibold text-ink"><BarChart3 className="h-3.5 w-3.5 text-primary" />同花顺板块指数近 60 日</span>
          <span className="font-mono text-muted">bk_{block.code} · 日线</span>
        </div>
        {blockPrices.length > 0
          ? <Sparkline values={blockPrices.map((price) => price.close)} positive={change >= 0} />
          : <EmptyState title="板块指数行情暂不可用" description="仅使用同花顺板块指数接口，不以个股或中证指数行情代替。" />}
      </section>

      <section>
        <SectionHeading title="涨停个股" action={<div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" /><input className="terminal-field focus-ring w-52 pl-8" placeholder="搜索名称 / 代码" value={stockQuery} onChange={(event) => setStockQuery(event.target.value)} /></div>} />
        <div className="table-scroll">
          <table className="data-table min-w-[760px]">
            <thead><tr><th className="w-16 text-center">#</th><th><SortButton field="name">股票名称</SortButton></th><th className="text-center"><SortButton field="continue_num">连板</SortButton></th><th className="text-right"><SortButton field="change_rate">涨幅</SortButton></th><th>涨停原因</th><th className="w-28 text-right">行情</th></tr></thead>
            <tbody>
              {stocks.length === 0 ? <tr><td colSpan={6}><EmptyState title="没有匹配个股" description="换一个关键词试试。" /></td></tr> : stocks.map((stock, index) => (
                <tr key={`${stock.code}-${index}`} className="cursor-pointer" onClick={() => setSelectedStock(stock)}>
                  <td className="text-center font-mono text-xs text-muted">{String(index + 1).padStart(2, '0')}</td>
                  <td><div className="font-semibold text-ink">{stock.name}</div><div className="mt-0.5 font-mono text-[11px] text-muted">{stock.code}</div></td>
                  <td className="text-center"><span className="bg-[#2b2417] px-2 py-0.5 font-mono text-[11px] font-semibold text-primary" style={{ borderRadius: 2 }}>{stock.continue_num ?? 1} 板</span></td>
                  <td className={`text-right font-mono text-xs font-semibold ${pctColor(Number(stock.change_rate ?? 0))}`}>{Number(stock.change_rate ?? 0) > 0 ? '+' : ''}{Number(stock.change_rate ?? 0).toFixed(2)}%</td>
                  <td className="max-w-md whitespace-normal"><span className="line-clamp-2 text-xs leading-5 text-body">{stock.reason_type ?? '—'}</span></td>
                  <td className="text-right"><span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted group-hover:text-primary">查看行情 <ExternalLink className="h-3 w-3" /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Modal open={Boolean(selectedStock)} onClose={() => setSelectedStock(null)} title={selectedStock ? `${selectedStock.name} · 涨停观察` : ''} description={selectedStock ? `${selectedStock.code} · ${selectedStock.high ?? `${selectedStock.continue_num ?? 1}板`}` : ''} width="max-w-2xl">
        {selectedStock && (
          <div className="space-y-5">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="border border-line bg-surface p-2.5"><div className="text-[11px] text-muted">现价</div><div className="mt-1 font-mono text-base font-semibold text-ink">¥{Number(selectedStock.latest ?? 0).toFixed(2)}</div></div>
              <div className="border border-line bg-surface p-2.5"><div className="text-[11px] text-muted">涨幅</div><div className={`mt-1 font-mono text-base font-semibold ${pctColor(Number(selectedStock.change_rate ?? 0))}`}>{Number(selectedStock.change_rate ?? 0).toFixed(2)}%</div></div>
              <div className="border border-line bg-surface p-2.5"><div className="text-[11px] text-muted">连板</div><div className="mt-1 font-mono text-base font-semibold text-primary">{selectedStock.continue_num ?? 1}</div></div>
            </div>
            <div className="border border-line bg-surface p-3"><div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-ink"><BarChart3 className="h-3.5 w-3.5 text-primary" />近 45 个交易日收盘轨迹</div><Sparkline values={prices.map((price) => price.close)} positive={Number(selectedStock.change_rate ?? 0) >= 0} /></div>
            <div className="bg-surface-elevated p-3"><div className="flex items-center gap-2 text-[11px] font-semibold text-ink"><Info className="h-3.5 w-3.5 text-info" />涨停逻辑</div><p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-body">{selectedStock.reason_info || selectedStock.reason_type || '暂无公开原因摘要。'}</p></div>
          </div>
        )}
      </Modal>
      </div>
    </>
  );
}
