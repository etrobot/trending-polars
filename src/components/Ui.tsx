import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react';

export function Button({
  variant = 'secondary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'border-primary bg-primary text-on-primary hover:border-primary-active hover:bg-primary-active',
    secondary: 'border-line bg-surface text-ink hover:border-primary hover:text-primary',
    ghost: 'border-transparent bg-transparent text-muted hover:border-line hover:bg-surface-elevated hover:text-ink',
    danger: 'border-red-cn bg-red-cn text-white hover:border-red-cn-dark hover:bg-red-cn-dark',
  };
  return (
    <button
      className={`focus-ring inline-flex min-h-8 items-center justify-center gap-1.5 border px-2.5 py-1.5 font-mono text-[12px] font-semibold tracking-[0.04em] transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`}
      style={{ borderRadius: 2 }}
      {...props}
    >
      {children}
    </button>
  );
}

export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="flex items-center gap-2">
          <span className="h-3 w-0.5 bg-primary" />
          <h2 className="font-display text-[16px] leading-none font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        </div>
        {description && <p className="max-w-3xl text-[11px] leading-4 text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function MetricCard({ label, value, detail, tone = 'neutral', icon }: { label: string; value: ReactNode; detail?: ReactNode; tone?: 'neutral' | 'coral' | 'green' | 'dark'; icon?: ReactNode }) {
  const tones = {
    neutral: 'border-line bg-surface text-ink',
    coral: 'border-primary/55 bg-[#1e2319] text-ink',
    green: 'border-green/55 bg-[#15241c] text-ink',
    dark: 'border-white/10 bg-navy text-white',
  };
  return (
    <div className={`min-h-[82px] border px-3 py-2.5 ${tones[tone]}`} style={{ borderRadius: 3 }}>
      <div className="flex items-center justify-between gap-3">
        <span className={`font-mono text-[11px] font-semibold tracking-[0.11em] uppercase ${tone === 'dark' ? 'text-white/48' : 'text-muted'}`}>{label}</span>
        {icon && <span className={tone === 'dark' ? 'text-white/45' : tone === 'green' ? 'text-green' : 'text-primary'}>{icon}</span>}
      </div>
      <div className="mt-2 font-mono text-[20px] leading-none font-semibold tracking-[-0.04em]">{value}</div>
      {detail && <div className={`mt-1.5 text-[11px] leading-3.5 ${tone === 'dark' ? 'text-white/48' : 'text-muted'}`}>{detail}</div>}
    </div>
  );
}

export function LoadingPanel({ label = '正在加载数据…' }: { label?: string }) {
  return (
    <div className="panel flex min-h-48 flex-col items-center justify-center gap-2 p-8 text-muted">
      <LoaderCircle className="h-5 w-5 animate-spin text-primary" />
      <span className="font-mono text-[11px] tracking-[0.06em]">{label}</span>
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center px-5 py-7 text-center">
      <div className="font-display text-lg font-semibold text-ink">{title}</div>
      {description && <p className="mt-1.5 max-w-md text-[11px] leading-4 text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-elevated px-3 py-2">
      <span className="font-mono text-[11px] text-muted">PAGE {page} / {Math.max(1, pages)}</span>
      <div className="flex gap-1">
        <Button variant="ghost" className="h-7 min-h-7 px-2" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="上一页"><ArrowLeft className="h-3 w-3" /></Button>
        <Button variant="ghost" className="h-7 min-h-7 px-2" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="下一页"><ArrowRight className="h-3 w-3" /></Button>
      </div>
    </div>
  );
}
