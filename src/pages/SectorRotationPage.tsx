import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageHeaderActions } from '../components/HeaderActions';
import { SectorCandles } from '../components/SectorCandles';
import { SectorRotationChart } from '../components/SectorRotationChart';
import { Button, EmptyState, LoadingPanel } from '../components/Ui';
import { api, pctColor } from '../lib/api';
import { clusterSectors } from '../lib/sector-rotation';
import type { SectorMomentumTag, SectorRotationResponse } from '../types';

const TAG_TEXT_STYLES: Record<SectorMomentumTag, string> = {
  资金正关注: 'text-primary-active',
  稳定: 'text-green',
  阴跌: 'text-red-cn',
  加速下跌: 'text-red-cn',
  交易平稳: 'text-muted',
  反转发生中: 'text-primary-active',
  基数过小: 'text-muted',
  数据不足: 'text-muted',
};

const LEVEL_STYLES: Record<string, string> = {
  平稳介入: 'text-green',
  可关注: 'text-primary-active',
  观察: 'text-muted',
  回避: 'text-red-cn',
};

function signed(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function SectorRotationPage() {
  const [data, setData] = useState<SectorRotationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 近30日：只对比最近 30 个交易日内涨停过的概念板块；关闭后对比今年全年涨停过的概念板块。
  const [recentOnly, setRecentOnly] = useState(true);
  // 图例点击可隐藏/显示对应走势组，只影响图表，不影响排行与统计。
  const [hiddenGroups, setHiddenGroups] = useState<Set<number>>(new Set());

  const toggleGroup = useCallback((group: number) => {
    setHiddenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api<SectorRotationResponse>(`/api/sector-rotation?basis=limit_up&window=${recentOnly ? 'recent' : 'year'}`));
      // 换了对比范围后走势组会重新编号，旧的隐藏状态不再适用。
      setHiddenGroups(new Set());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [recentOnly]);

  useEffect(() => { void load(); }, [load]);

  const clustered = useMemo(() => clusterSectors(data?.sectors ?? []), [data]);
  const groups = useMemo(() => {
    const map = new Map<number, { color: string; opacity: number; names: string[] }>();
    for (const item of clustered) {
      const group = map.get(item.cluster) ?? { color: item.color, opacity: item.opacity, names: [] };
      // 图例里直接带上年初至今涨跌幅，例如「食品加工制造(-16.47%)」。
      const changePct = item.sector.changePct;
      group.names.push(`${item.sector.name}(${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%)`);
      map.set(item.cluster, group);
    }
    return [...map.entries()];
  }, [clustered]);

  /** 点击整行：仅勾选当前组；若当前已是「只显示这一组」，再点一次恢复全部。 */
  const isolateGroup = useCallback((group: number) => {
    setHiddenGroups((previous) => {
      const visibleCount = groups.filter(([cluster]) => !previous.has(cluster)).length;
      if (visibleCount === 1 && !previous.has(group)) return new Set();
      return new Set(groups.filter(([cluster]) => cluster !== group).map(([cluster]) => cluster));
    });
  }, [groups]);

  const lines = clustered
    .filter((item) => !hiddenGroups.has(item.cluster))
    .map((item) => ({
      code: item.sector.code,
      name: item.sector.name,
      series: item.sector.series,
      color: item.color,
      opacity: item.opacity,
    }));

  // 排行榜按平稳介入评分降序，且只展示当前勾选（未隐藏）走势组的板块。
  const ranked = useMemo(() => {
    const clusters = new Map(clustered.map((item) => [item.sector.code, item]));
    return [...(data?.sectors ?? [])]
      .filter((sector) => {
        const cluster = clusters.get(sector.code);
        return cluster != null && !hiddenGroups.has(cluster.cluster);
      })
      .sort((left, right) => right.entryScore - left.entryScore || right.changePct - left.changePct)
      .map((sector) => ({ sector, cluster: clusters.get(sector.code) }));
  }, [data, clustered, hiddenGroups]);

  const top = data?.sectors[0];
  const bottom = data?.sectors[data.sectors.length - 1];
  const best = ranked[0]?.sector;

  if (loading) return <><PageHeaderActions><Button variant="ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button></PageHeaderActions><LoadingPanel label="正在读取今年板块行情…" /></>;
  if (error) return <><PageHeaderActions><Button variant="ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button></PageHeaderActions><div className="panel"><EmptyState title="板块轮动不可用" description={error} /></div></>;
  if (!data) return <><PageHeaderActions><Button variant="ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button></PageHeaderActions><div className="panel"><EmptyState title="暂无板块数据" description="刷新行情后再试。" /></div></>;

  return (
    <>
      <PageHeaderActions>
        <Button variant="ghost" onClick={() => void load()}><RefreshCw className="h-3.5 w-3.5" />刷新</Button>
      </PageHeaderActions>
      <div className="terminal-page animate-enter">
        <div className="grid items-start gap-3 xl:h-[calc(100vh-64px)] xl:min-h-[560px] xl:grid-cols-[minmax(0,1fr)_minmax(420px,480px)] xl:items-stretch">
          <section className="panel flex min-h-0 flex-col overflow-hidden">
            <div className="flex items-center gap-x-3 overflow-x-auto border-l-[3px] border-l-primary px-3 py-2.5">
              <div className="flex shrink-0 flex-col gap-1">
                <div className="flex items-center gap-2.5">
                  <h1 className="font-display text-base leading-none text-ink">板块轮动分析</h1>
                  <label className="flex cursor-pointer items-center gap-1.5 border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted hover:border-primary-active hover:text-ink" style={{ borderRadius: 2 }}>
                    <input
                      type="checkbox"
                      className="h-3 w-3"
                      checked={recentOnly}
                      onChange={(event) => setRecentOnly(event.target.checked)}
                    />
                    近30日
                  </label>
                </div>
                <span className="font-mono text-[11px] whitespace-nowrap text-muted">
                  {data.year} 年至今 · {recentOnly ? '近30日' : '今年全年'}涨停概念板块
                </span>
              </div>
              {/* 统计项不换行，整行放不下时横向滚动，避免「领跌」被折到下一行 */}
              <div className="flex shrink-0 items-center gap-3">
                {[
                  ['涨停概念', String(data.sectors.length), 'text-ink'],
                  ['走势分组', String(groups.length), 'text-ink'],
                  ['最佳介入', best ? `${best.name} ${best.entryScore}分` : '—', best ? LEVEL_STYLES[best.entryLevel] ?? 'text-ink' : 'text-muted'],
                  ['领涨', top ? `${top.name} ${signed(top.changePct)}%` : '—', top ? pctColor(top.changePct) : 'text-muted'],
                  ['领跌', bottom ? `${bottom.name} ${signed(bottom.changePct)}%` : '—', bottom ? pctColor(bottom.changePct) : 'text-muted'],
                ].map(([label, value, valueClass]) => (
                  <div key={label} className="shrink-0 border-l border-line pl-3">
                    <div className="font-mono text-[11px] whitespace-nowrap text-muted">{label}</div>
                    <div className={`mt-0.5 font-mono text-[11px] whitespace-nowrap ${valueClass}`}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-center border-t border-line px-3 py-2">
              {data.sectors.length === 0 ? (
                <EmptyState title="今年还没有可用的板块日线数据" description="先在「市场总览」刷新板块行情，或等待采集任务写入 block_daily_price 后再回来对比。" />
              ) : (
                <SectorRotationChart
                  dates={data.dates}
                  lines={lines}
                  emptyText={hiddenGroups.size ? '已隐藏全部走势组，点击下方图例恢复显示' : undefined}
                />
              )}
            </div>
            {groups.length > 0 && (
              <div className="flex flex-1 min-h-0 flex-col border-t border-line bg-surface-elevated px-3 py-2">
                <div className="mb-1.5 flex shrink-0 items-center justify-between gap-3">
                  <span className="font-mono text-[10px] tracking-[0.08em] text-muted">勾选=显示该组 · 点击整行=仅显示该组 · 涨暖跌冷，组越大越淡</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="font-mono text-[10px] text-primary-active hover:underline disabled:text-muted disabled:no-underline"
                      disabled={hiddenGroups.size === 0}
                      onClick={() => setHiddenGroups(new Set())}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="font-mono text-[10px] text-primary-active hover:underline disabled:text-muted disabled:no-underline"
                      disabled={hiddenGroups.size >= groups.length}
                      onClick={() => setHiddenGroups(new Set(groups.map(([cluster]) => cluster)))}
                    >
                      清空
                    </button>
                  </div>
                </div>
                <div className="grid max-h-[180px] min-h-0 flex-1 gap-2 overflow-y-auto sm:grid-cols-2 xl:max-h-none">
                  {groups.map(([cluster, group]) => {
                    const visible = !hiddenGroups.has(cluster);
                    return (
                      <div
                        key={cluster}
                        role="button"
                        tabIndex={0}
                        onClick={() => isolateGroup(cluster)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            isolateGroup(cluster);
                          }
                        }}
                        className={`flex w-full cursor-pointer items-start gap-2 rounded-sm px-1 py-0.5 text-left transition hover:bg-surface ${visible ? '' : 'opacity-45'}`}
                      >
                        <input
                          type="checkbox"
                          checked={visible}
                          aria-label={`显示走势组 ${String(cluster + 1).padStart(2, '0')}`}
                          className="mt-1 h-3 w-3 shrink-0 cursor-pointer accent-primary"
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleGroup(cluster)}
                        />
                        <span className="mt-1.5 h-2 w-2 shrink-0" style={{ backgroundColor: group.color, opacity: group.opacity, borderRadius: 1 }} />
                        <div className="min-w-0">
                          <div className={`font-mono text-[11px] ${visible ? 'text-ink' : 'text-muted line-through'}`}>
                            走势组 {String(cluster + 1).padStart(2, '0')} · {group.names.length} 个板块
                          </div>
                          <div className="mt-0.5 text-[11px] leading-4 text-muted">{group.names.join('、')}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section className="panel flex min-h-0 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-l-[3px] border-l-primary px-3 py-2.5">
              <h2 className="font-display text-[15px] leading-none text-ink">板块评分排行</h2>
              <span className="font-mono text-[11px] text-muted">
                平稳介入优先 · {hiddenGroups.size === 0 ? '全部走势组' : `仅勾选组（${ranked.length} 个板块）`}
              </span>
            </div>
            <div className="max-h-[520px] flex-1 min-h-0 overflow-auto border-t border-line xl:max-h-none">
              <table className="data-table min-w-[440px]">
                <thead>
                  <tr>
                    <th className="w-8 text-center">#</th>
                    <th>板块</th>
                    <th className="w-28 text-center">近一周</th>
                    <th className="w-24 text-right">评分 · 标记</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.length === 0 ? (
                    <tr><td colSpan={4}><EmptyState title={data.sectors.length ? '未勾选任何走势组' : '暂无板块数据'} description={data.sectors.length ? '在左侧图例勾选走势组后，这里显示对应板块。' : '刷新行情后自动生成。'} /></td></tr>
                  ) : ranked.map(({ sector, cluster }, index) => (
                    <tr key={sector.code}>
                      <td className="text-center font-mono text-xs text-muted">{String(index + 1).padStart(2, '0')}</td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <span
                            className="inline-flex h-4 min-w-[28px] shrink-0 items-center justify-center px-1 font-mono text-[9px] leading-none text-white"
                            style={{ backgroundColor: cluster?.color ?? '#9a9c92', borderRadius: 2 }}
                          >
                            组{String((cluster?.cluster ?? 0) + 1).padStart(2, '0')}
                          </span>
                          <span className="font-semibold text-ink">{sector.name}</span>
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-muted">
                          年初 {signed(sector.changePct)}% · 近2月 {sector.recentChangePct == null ? '—' : `${signed(sector.recentChangePct)}%`} · {sector.momentumRatio == null ? '—' : `×${sector.momentumRatio.toFixed(2)}`}
                        </div>
                      </td>
                      <td className="text-center">
                        <div className="flex justify-center"><SectorCandles candles={sector.candles} /></div>
                      </td>
                      <td className="text-right">
                        <div className="font-mono text-xs text-ink">
                          <span className={LEVEL_STYLES[sector.entryLevel] ?? 'text-muted'}>{sector.entryLevel}</span> {sector.entryScore}
                        </div>
                        <div className={`mt-0.5 font-mono text-[10px] ${TAG_TEXT_STYLES[sector.tag]}`}>{sector.tag}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
