import type { MarketState, StrategyAction } from '../types';
import { sentimentLabel } from '../lib/api';

const stateClasses: Record<number, string> = {
  1: 'bg-accent-green-soft text-trading-down ring-accent-green-soft',
  2: 'bg-primary/10 text-primary-active ring-primary/10',
  3: 'bg-accent-blue-soft text-accent-blue ring-accent-blue-soft',
  4: 'bg-accent-purple-soft text-accent-purple ring-accent-purple-soft',
  5: 'bg-accent-green-soft text-[#1a5a4a] ring-accent-green-soft',
  6: 'bg-accent-green-soft text-accent-green ring-accent-green-soft',
  7: 'bg-primary/10 text-primary-active ring-primary/10',
};

export function StatePill({ state, compact = false }: { state?: MarketState; compact?: boolean }) {
  const id = Number(state?.state_id ?? 0);
  return (
    <span className={`inline-flex items-center font-mono ring-1 ring-inset ${compact ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-[11px]'} ${stateClasses[id] ?? 'bg-surface-elevated text-muted ring-line'}`} style={{ borderRadius: 2 }}>
      {id ? state?.state_name : '数据不足'}
    </span>
  );
}

const strategyClasses: Record<StrategyAction, string> = {
  accumulate: 'bg-accent-green-soft text-trading-down ring-accent-green-soft',
  trade: 'bg-primary/10 text-primary-active ring-primary/10',
  reduce: 'bg-accent-red-soft text-trading-up ring-accent-red-soft',
  ignore: 'bg-surface-elevated text-muted ring-line',
};

export function StrategyPill({ action, label }: { action: StrategyAction; label?: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 font-mono text-[11px] ring-1 ring-inset ${strategyClasses[action] ?? strategyClasses.ignore}`} style={{ borderRadius: 2 }}>
      {label ?? ({ accumulate: '加仓', trade: '博弈', reduce: '减仓', ignore: '回避' } as const)[action]}
    </span>
  );
}

export function SentimentPill({ sentiment }: { sentiment: string }) {
  const className = sentiment === 'hot'
    ? 'bg-accent-red-soft text-trading-up ring-accent-red-soft'
    : sentiment === 'normal'
      ? 'bg-primary/10 text-primary-active ring-primary/10'
      : 'bg-accent-blue-soft text-accent-blue ring-accent-blue-soft';
  return <span className={`inline-flex px-2 py-0.5 font-mono text-[11px] ring-1 ring-inset ${className}`} style={{ borderRadius: 2 }}>{sentimentLabel(sentiment)}</span>;
}