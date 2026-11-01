import type { SectorCandle } from '../types';

/**
 * 近一周蜡烛 + MA5 / MA10 迷你图。
 * 上涨用红、下跌用绿（沿用站点 A 股配色），均线为蓝 / 橙。
 */
export function SectorCandles({ candles }: { candles: SectorCandle[] }) {
  const width = 84;
  const height = 40;
  const pad = 3;

  if (!candles.length) return <span className="font-mono text-[11px] text-muted">—</span>;

  const values = candles.flatMap((candle) => [candle.low, candle.high, candle.ma5 ?? candle.close, candle.ma10 ?? candle.close]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = (width - pad * 2) / candles.length;
  const bodyWidth = Math.max(1.5, Math.min(6, step * 0.55));
  const x = (index: number) => pad + step * (index + 0.5);
  const y = (value: number) => pad + (height - pad * 2) - ((value - min) / range) * (height - pad * 2);

  const linePoints = (key: 'ma5' | 'ma10') => candles
    .map((candle, index) => (candle[key] == null ? null : `${x(index).toFixed(1)},${y(candle[key]!).toFixed(1)}`))
    .filter((point): point is string => point != null)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="近一周蜡烛与均线">
      {candles.map((candle, index) => {
        const up = candle.close >= candle.open;
        const color = up ? '#cd4239' : '#2c8c66';
        const bodyTop = y(Math.max(candle.open, candle.close));
        const bodyHeight = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
        return (
          <g key={candle.date}>
            <line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="0.9" />
            <rect x={x(index) - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={up ? color : '#ffffff'} stroke={color} strokeWidth="0.9" />
          </g>
        );
      })}
      <polyline points={linePoints('ma5')} fill="none" stroke="#3d6fb0" strokeWidth="1" strokeLinejoin="round" />
      <polyline points={linePoints('ma10')} fill="none" stroke="#c08a2e" strokeWidth="1" strokeDasharray="2 2" strokeLinejoin="round" />
    </svg>
  );
}
