import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { formatDateTime } from './format.js';

export type AuditLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AuditError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  level: AuditLevel;
  component: string;
  event: string;
  trace_id?: string;
  parent_trace_id?: string;
  duration_ms?: number;
  data?: unknown;
  error?: AuditError;
}

export interface AuditDetails {
  traceId?: string;
  parentTraceId?: string;
  durationMs?: number;
  data?: unknown;
  error?: unknown;
}

export interface AuditQuery {
  limit?: number;
  date?: string;
  level?: AuditLevel;
  component?: string;
  event?: string;
  traceId?: string;
  search?: string;
}

export interface AuditLogFile {
  date: string;
  name: string;
  size: number;
}

export interface AuditLoggerLike {
  debug(component: string, event: string, details?: AuditDetails): Promise<void>;
  info(component: string, event: string, details?: AuditDetails): Promise<void>;
  warn(component: string, event: string, details?: AuditDetails): Promise<void>;
  error(component: string, event: string, details?: AuditDetails): Promise<void>;
  query(query?: AuditQuery): Promise<AuditRecord[]>;
  files(): Promise<AuditLogFile[]>;
}

function errorDetails(error: unknown): AuditError | undefined {
  if (error == null) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: normalize(error.cause),
    };
  }
  return { name: 'Error', message: String(error) };
}

function normalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Error) return errorDetails(item);
      return item;
    })) as unknown;
  } catch {
    return String(value);
  }
}

function compactLogDate(value: string): string {
  return value.replaceAll('-', '').slice(0, 8);
}

export const NOOP_AUDIT_LOGGER: AuditLoggerLike = {
  debug: async () => undefined,
  info: async () => undefined,
  warn: async () => undefined,
  error: async () => undefined,
  query: async () => [],
  files: async () => [],
};

export function guardDetachedPromise(
  operation: Promise<unknown>,
  component: string,
  event: string,
): void {
  void operation.catch((error) => {
    const fallback = {
      timestamp: formatDateTime(),
      level: 'error',
      component: 'runtime',
      event: 'detached_operation_failed',
      data: { component, event, fallback: 'stderr' },
      error: errorDetails(error),
    };
    try {
      process.stderr.write(`${JSON.stringify(fallback)}\n`);
    } catch {
      // There is no safer fallback when both the audit file and stderr are unavailable.
    }
  });
}

export class AuditLogger implements AuditLoggerLike {
  private writeQueue: Promise<void> = Promise.resolve();
  private lastPrunedDate = '';

  constructor(
    readonly directory: string,
    private readonly options: { retentionDays?: number; now?: () => Date } = {},
  ) {}

  debug(component: string, event: string, details?: AuditDetails) {
    return this.write('debug', component, event, details);
  }

  info(component: string, event: string, details?: AuditDetails) {
    return this.write('info', component, event, details);
  }

  warn(component: string, event: string, details?: AuditDetails) {
    return this.write('warn', component, event, details);
  }

  error(component: string, event: string, details?: AuditDetails) {
    return this.write('error', component, event, details);
  }

  async query(query: AuditQuery = {}): Promise<AuditRecord[]> {
    await this.writeQueue;
    const limit = Math.min(5_000, Math.max(1, Math.trunc(query.limit ?? 200)));
    const files = await this.logFiles(query.date);
    const records: AuditRecord[] = [];
    for (const file of files) {
      let content = '';
      try {
        content = await readFile(path.join(this.directory, file.name), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        if (query.search && !line.toLowerCase().includes(query.search.toLowerCase())) continue;
        try {
          const record = JSON.parse(line) as AuditRecord;
          if (query.level && record.level !== query.level) continue;
          if (query.component && record.component !== query.component) continue;
          if (query.event && record.event !== query.event) continue;
          if (query.traceId && record.trace_id !== query.traceId && record.parent_trace_id !== query.traceId) continue;
          records.push(record);
          if (records.length >= limit) return records;
        } catch {
          // Ignore a partially written or externally edited line and continue with earlier records.
        }
      }
    }
    return records;
  }

  async files(): Promise<AuditLogFile[]> {
    await this.writeQueue;
    return this.logFiles();
  }

  flush(): Promise<void> {
    return this.writeQueue;
  }

  private write(level: AuditLevel, component: string, event: string, details: AuditDetails = {}): Promise<void> {
    const timestamp = formatDateTime(this.options.now?.() ?? new Date());
    const record: AuditRecord = {
      id: randomUUID(),
      timestamp,
      level,
      component,
      event,
      trace_id: details.traceId,
      parent_trace_id: details.parentTraceId,
      duration_ms: details.durationMs == null ? undefined : Math.max(0, Math.round(details.durationMs)),
      data: normalize(details.data),
      error: errorDetails(details.error),
    };
    const operation = async () => {
      await mkdir(this.directory, { recursive: true });
      const date = compactLogDate(timestamp);
      await appendFile(path.join(this.directory, `quant-audit-${date}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
      if (date !== this.lastPrunedDate) {
        this.lastPrunedDate = date;
        await this.prune(date);
      }
    };
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async logFiles(onlyDate?: string): Promise<AuditLogFile[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const wantedDate = onlyDate?.replaceAll('-', '').slice(0, 8);
    const files: AuditLogFile[] = [];
    for (const name of names) {
      const match = name.match(/^quant-audit-(\d{8})\.jsonl$/);
      if (!match || (wantedDate && match[1] !== wantedDate)) continue;
      try {
        const metadata = await stat(path.join(this.directory, name));
        files.push({ date: match[1], name, size: metadata.size });
      } catch {
        // File may have been rotated between listing and stat.
      }
    }
    return files.sort((left, right) => right.date.localeCompare(left.date));
  }

  private async prune(currentDate: string) {
    const retentionDays = Math.max(1, Math.trunc(this.options.retentionDays ?? 30));
    const cutoff = new Date(`${currentDate.slice(0, 4)}-${currentDate.slice(4, 6)}-${currentDate.slice(6, 8)}T12:00:00+08:00`);
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    const cutoffDate = formatDateTime(cutoff).replaceAll('-', '').slice(0, 8);
    for (const file of await this.logFiles()) {
      if (file.date >= cutoffDate) continue;
      try {
        await unlink(path.join(this.directory, file.name));
      } catch {
        // Retention cleanup is best effort and must never block trading.
      }
    }
  }
}
