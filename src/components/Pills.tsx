import type { MarketState, StrategyAction } from '../types';
import { sentimentLabel } from '../lib/api';

const stateClasses: Record<number, string> = {
  1: 'bg-[#14261c] text-trading-down ring-[#245a3a]',
  2: 'bg-[#2b2417] text-primary ring-[#5d4c27]',
  3: 'bg-[#18262c] text-[#79b9d1] ring-[#315d6f]',
  4: 'bg-[#25212c] text-[#b7a8cd] ring-[#4d425e]',
  5: 'bg-[#321918] text-trading-up ring-[#6c2a25]',
  6: 'bg-[#172724] text-[#5ebcaf] ring-[#2b5b53]',
  7: 'bg-[#2d2118] text-[#e09a64] ring-[#67472e]',
};

export function StatePill({ state, compact = false }: { state?: MarketState; compact?: boolean }) {
  const id = Number(state?.state_id ?? 0);
  return (
    <span className={`inline-flex items-center font-mono font-semibold ring-1 ring-inset ${compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[11px]'} ${stateClasses[id] ?? 'bg-surface-elevated text-muted ring-line'}`} style={{ borderRadius: 2 }}>
      {id ? state?.state_name : '数据不足'}
    </span>
  );
}

const strategyClasses: Record<StrategyAction, string> = {
  accumulate: 'bg-[#14261c] text-trading-down ring-[#245a3a]',
  trade: 'bg-[#2b2417] text-primary ring-[#5d4c27]',
  reduce: 'bg-[#321918] text-trading-up ring-[#6c2a25]',
  ignore: 'bg-surface-elevated text-muted ring-line',
};

export function StrategyPill({ action, label }: { action: StrategyAction; label?: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 font-mono text-[11px] font-semibold ring-1 ring-inset ${strategyClasses[action] ?? strategyClasses.ignore}`} style={{ borderRadius: 2 }}>
      {label ?? ({ accumulate: '加仓', trade: '博弈', reduce: '减仓', ignore: '回避' } as const)[action]}
    </span>
  );
}

export function SentimentPill({ sentiment }: { sentiment: string }) {
  const className = sentiment === 'hot'
    ? 'bg-[#321918] text-trading-up ring-[#6c2a25]'
    : sentiment === 'normal'
      ? 'bg-[#2b2417] text-primary ring-[#5d4c27]'
      : 'bg-[#18262c] text-[#79b9d1] ring-[#315d6f]';
  return <span className={`inline-flex px-2 py-0.5 font-mono text-[11px] font-semibold ring-1 ring-inset ${className}`} style={{ borderRadius: 2 }}>{sentimentLabel(sentiment)}</span>;
}
