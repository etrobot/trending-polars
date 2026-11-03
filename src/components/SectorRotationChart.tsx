import type { SectorRotationSector } from '../types';

interface Line extends Pick<SectorRotationSector, 'code' | 'name' | 'series'> {
  color: string;
  opacity?: number;
  /** 隐藏的折线仍参与坐标轴计算，只是以透明度 0 渲染，保证切换显隐时坐标不变。 */
  hidden?: boolean;
}

function axisTicks(min: number, max: number, count = 6): number[] {
  const span = Math.max(1, max - min);
  const rough = span / Math.max(1, count - 1);
  const exponent = Math.floor(Math.log10(rough));
  const fraction = rough / 10 ** exponent;
  const step = (fraction <= 1.5 ? 1 : fraction <= 3.5 ? 2 : fraction <= 7.5 ? 5 : 10) * 10 ** exponent;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 0.5; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}

function dateLabel(date: string): string {
  const compact = date.replace(/\D/g, '');
  return compact.length >= 8 ? `${Number(compact.slice(4, 6))}/${Number(compact.slice(6, 8))}` : date;
}

export function SectorRotationChart({ dates, lines, emptyText }: { dates: string[]; lines: Line[]; emptyText?: string }) {
  const width = 1200;
  const height = 420;
  const pad = { top: 16, right: 18, bottom: 28, left: 54 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;

  const values = lines.flatMap((line) => line.series).filter((value): value is number => value != null);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;

  const x = (index: number) => pad.left + (index / Math.max(1, dates.length - 1)) * innerWidth;
  const y = (value: number) => pad.top + innerHeight - ((value - min) / range) * innerHeight;

  const segments = (series: Array<number | null>) => {
    const result: string[] = [];
    let chunk: string[] = [];
    series.forEach((value, index) => {
      if (value == null) {
        if (chunk.length > 1) result.push(chunk.join(' '));
        chunk = [];
        return;
      }
      chunk.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
    });
    if (chunk.length > 1) result.push(chunk.join(' '));
    return result;
  };

  const ticks = axisTicks(min, max, 6);
  const labelIndexes = dates.length >= 2
    ? [0, Math.floor((dates.length - 1) / 2), dates.length - 1]
    : dates.length === 1 ? [0] : [];

  if (!dates.length || lines.every((line) => line.hidden)) {
    return <div className="flex h-64 items-center justify-center text-[11px] text-muted">{emptyText ?? '今年还没有可用于对比的板块日线数据'}</div>;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="max-h-full w-full" style={{ aspectRatio: `${width}/${height}` }} role="img" aria-label="板块年初至今涨跌幅对比">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="#bfc1b7" strokeDasharray="3 5" />
          <text x={pad.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" fill="#6c6e63" fontSize="10" fontFamily="JetBrains Mono, monospace">
            {tick > 0 ? '+' : ''}{tick.toFixed(0)}%
          </text>
        </g>
      ))}
      {min < 0 && max > 0 ? (
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="#8c8e87" strokeWidth="1" />
      ) : null}
      {labelIndexes.map((index, order) => (
        <text
          key={index}
          x={x(index)}
          y={height - 8}
          textAnchor={order === 0 ? 'start' : order === labelIndexes.length - 1 ? 'end' : 'middle'}
          fill="#6c6e63"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
        >
          {dateLabel(dates[index])}
        </text>
      ))}
      {lines.map((line) => segments(line.series).map((points, index) => (
        <polyline
          key={`${line.code}-${index}`}
          points={points}
          fill="none"
          stroke={line.color}
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={line.hidden ? 0 : (line.opacity ?? 0.9)}
        />
      )))}
    </svg>
  );
}
