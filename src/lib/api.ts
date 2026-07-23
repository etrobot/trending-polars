export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `请求失败 (${response.status})`);
  }
  return payload as T;
}

export function formatMoney(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function pctColor(value: number): string {
  if (value > 0) return 'text-trading-up';
  if (value < 0) return 'text-trading-down';
  return 'text-muted';
}

export function sentimentLabel(value: string): string {
  return ({ hot: '炽热', normal: '中性', cold: '冷清' } as Record<string, string>)[value] ?? value;
}
