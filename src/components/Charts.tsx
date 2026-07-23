import type { EquityPoint } from '../types';

function points(values: number[], width: number, height: number, padding: number) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((value, index) => ({
    x: padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2),
    y: height - padding - ((value - min) / range) * (height - padding * 2),
  }));
}

export function EquityCurve({ data }: { data: EquityPoint[] }) {
  if (data.length < 2) return <div className="flex h-44 items-center justify-center text-[11px] text-muted">当前记录没有净值曲线</div>;
  const width = 820;
  const height = 250;
  const padding = 18;
  const values = data.map((item) => Number(item.total));
  const line = points(values, width, height, padding);
  const polyline = line.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const positive = values.at(-1)! >= values[0];
  const stroke = positive ? '#f6465d' : '#0ecb81';
  const area = `M ${line[0].x} ${height - padding} L ${polyline.replaceAll(',', ' ')} L ${line.at(-1)!.x} ${height - padding} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full overflow-visible" style={{ aspectRatio: '820/250' }} role="img" aria-label="策略净值曲线">
        <defs>
          <linearGradient id="equity-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => <line key={ratio} x1={padding} x2={width - padding} y1={height * ratio} y2={height * ratio} stroke="#2b3139" strokeDasharray="3 5" />)}
        <path d={area} fill="url(#equity-area)" />
        <polyline points={polyline} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx={line.at(-1)!.x} cy={line.at(-1)!.y} r="4" fill={stroke} stroke="#0b0e11" strokeWidth="2" />
      </svg>
  );
}

export function Sparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  if (values.length < 2) return null;
  const width = 120;
  const height = 36;
  const line = points(values, width, height, 2);
  const polyline = line.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${width} ${height}`} className="h-9 w-28"><polyline points={polyline} fill="none" stroke={positive ? '#f6465d' : '#0ecb81'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
