import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../server/audit-log.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('structured audit log', () => {
  it('writes daily JSONL with trace, data, stack and query filters', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'trending-audit-'));
    roots.push(root);
    const audit = new AuditLogger(root, { now: () => new Date('2026-07-23T15:05:00+08:00') });

    await audit.info('factor_ranking', 'ranking_completed', {
      traceId: 'trace-ranking-001',
      durationMs: 128,
      data: { ranking_date: '20260723', top: [{ stock_code: '600001', score: 80 }] },
    });
    await audit.error('order', 'submission_uncertain', {
      traceId: 'trace-order-001',
      error: new Error('AppleScript 回查超时'),
    });

    const files = await audit.files();
    expect(files).toEqual([expect.objectContaining({ date: '20260723', name: 'quant-audit-20260723.jsonl' })]);
    const rankingLogs = await audit.query({ component: 'factor_ranking', traceId: 'trace-ranking-001' });
    expect(rankingLogs).toEqual([expect.objectContaining({
      level: 'info',
      event: 'ranking_completed',
      trace_id: 'trace-ranking-001',
      duration_ms: 128,
    })]);
    const errors = await audit.query({ level: 'error' });
    expect(errors[0].error).toMatchObject({ message: 'AppleScript 回查超时', name: 'Error' });
    expect(errors[0].error?.stack).toContain('AppleScript 回查超时');
  });
});
