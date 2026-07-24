import type { EquityPoint } from '../types';

function niceStep(rough: number): number {
  const exp = Math.floor(Math.log10(rough));
  const frac = rough / 10 ** exp;
  if (frac <= 1.5) return 1 * 10 ** exp;
  if (frac <= 3.5) return 2 * 10 ** exp;
  if (frac <= 7.5) return 5 * 10 ** exp;
  return 10 * 10 ** exp;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) {
    if (v >= min - step * 0.1 && v <= max + step * 0.1) {
      ticks.push(Math.round(v * 100) / 100);
    }
  }
  return ticks;
}

function formatAxisValue(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) {
    if (Math.abs(v) >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    return `${(v / 1_000).toFixed(1)}k`;
  }
  return v.toFixed(0);
}

function formatDateLabel(dateStr: string): string {
  const cleaned = dateStr.replace(/-/g, '');
  if (cleaned.length >= 8) {
    const m = parseInt(cleaned.slice(4, 6), 10);
    const d = parseInt(cleaned.slice(6, 8), 10);
    return `${m}/${d}`;
  }
  return dateStr;
}

function points(values: number[], width: number, height: number, padding: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((value, index) => ({
    x: padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2),
    y: height - padding - ((value - min) / range) * (height - padding * 2),
  }));
}

export function EquityCurve({ data, benchmark }: { data: EquityPoint[]; benchmark?: EquityPoint[] }) {
  if (data.length < 2) return <div className="flex h-44 items-center justify-center text-[11px] text-muted">当前记录没有净值曲线</div>;
  const width = 820;
  const height = 250;
  const pad = { top: 20, right: 16, bottom: 30, left: 58 };

  const values = data.map((item) => Number(item.total)).filter(Number.isFinite);
  if (values.length < 2) return <div className="flex h-44 items-center justify-center text-[11px] text-muted">净值数据无效</div>;
  const bmValues = benchmark?.map((item) => Number(item.total)).filter(Number.isFinite) ?? [];
  const allValues = bmValues.length ? [...values, ...bmValues] : values;
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const toPoint = (v: number, index: number, total: number) => ({
    x: pad.left + (index / Math.max(1, total - 1)) * innerW,
    y: pad.top + innerH - ((v - min) / range) * innerH,
  });

  const line = values.map((v, i) => toPoint(v, i, values.length));
  const polyline = line.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const positive = values.at(-1)! >= values[0];
  const stroke = positive ? '#cd4239' : '#2c8c66';
  const area = `M ${line[0].x} ${pad.top + innerH} L ${polyline.replaceAll(',', ' ')} L ${line.at(-1)!.x} ${pad.top + innerH} Z`;

  // Benchmark line
  let benchmarkLine: string | undefined;
  if (bmValues.length >= 2) {
    const bmPoints = bmValues.map((v, i) => toPoint(v, i, bmValues.length));
    benchmarkLine = bmPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }

  // Y-axis ticks
  const ticks = niceTicks(min, max, 5);
  // X-axis dates (first, middle, last)
  const dates = data.map((d) => d.date);
  const xLabels = [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]];

  return (
    <div>
      {/* Legend — HTML, no SVG occlusion */}
      <div className="mb-1.5 flex items-center justify-center gap-5 font-mono text-[10px] text-muted">
        <span className="flex items-center gap-1.5"><span className="inline-block h-[3px] w-3.5 rounded-sm" style={{ backgroundColor: stroke }} />策略净值</span>
        {benchmarkLine && <span className="flex items-center gap-1.5"><span className="inline-block h-0 border-t border-dashed" style={{ width: 14, borderColor: '#8c8e87' }} />基准指数</span>}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" style={{ aspectRatio: `${width}/${height}` }} role="img" aria-label="策略净值曲线">
        <defs>
          <linearGradient id="equity-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Y-axis grid lines and labels */}
        {ticks.map((tick) => {
          const y = pad.top + innerH - ((tick - min) / range) * innerH;
          return (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} stroke="#bfc1b7" strokeDasharray="3 5" />
              <text x={pad.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fill="#6c6e63" fontSize="10" fontFamily="JetBrains Mono, monospace">
                {formatAxisValue(tick)}
              </text>
            </g>
          );
        })}

        {/* X-axis date labels */}
        {xLabels.map((date, i) => {
          const idx = i === 0 ? 0 : i === 2 ? dates.length - 1 : Math.floor(dates.length / 2);
          const x = pad.left + (idx / Math.max(1, dates.length - 1)) * innerW;
          return (
            <text key={date} x={x} y={height - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fill="#6c6e63" fontSize="10" fontFamily="JetBrains Mono, monospace">
              {formatDateLabel(date)}
            </text>
          );
        })}

        {/* Benchmark line */}
        {benchmarkLine && <polyline points={benchmarkLine} fill="none" stroke="#8c8e87" strokeWidth="1.2" strokeLinejoin="round" strokeDasharray="4 3" />}

        {/* Area fill */}
        <path d={area} fill="url(#equity-area)" />

        {/* Strategy line */}
        <polyline points={polyline} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />

        {/* End dot */}
        <circle cx={line.at(-1)!.x} cy={line.at(-1)!.y} r="4" fill={stroke} stroke="#eeefe9" strokeWidth="2" />
      </svg>
    </div>
  );
}

export function Sparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  if (values.length < 2) return null;
  const width = 120;
  const height = 36;
  const line = points(values, width, height, 2);
  const polyline = line.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${width} ${height}`} className="h-9 w-28"><polyline points={polyline} fill="none" stroke={positive ? '#cd4239' : '#2c8c66'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
