import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_AUDIT_LOGGER } from '../server/audit-log.js';
import { registerRoutes } from '../server/app/routes.js';
import { TaskRegistry } from '../server/tasks.js';

async function waitForTask(client: ReturnType<typeof request>, taskId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await client.get(`/api/tasks/${taskId}`);
    if (['completed', 'failed', 'cancelled'].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not finish`);
}

describe('simulated-trading background tasks', () => {
  it('registers the close decision before running it', async () => {
    const tasks = new TaskRegistry(NOOP_AUDIT_LOGGER);
    const context = { rankingDate: '20260728' };
    const loadPaperContext = vi.fn(async () => context);
    const runWindowConfirmed = vi.fn(async () => ({
      ok: true,
      window: 'close',
      trading_date: '20260728',
      status: 'completed',
      results: [],
      message: '2026-07-28 收盘决策完成',
    }));
    const app = express();

    registerRoutes(app, {
      store: {} as never,
      tasks,
      paper: { runWindowConfirmed } as never,
      audit: NOOP_AUDIT_LOGGER,
    }, { loadPaperContext } as never, process.cwd());

    const client = request(app);
    const started = await client
      .post('/api/simulated-trading/automation/run-window')
      .send({ window: 'close' })
      .expect(202);

    expect(started.body).toMatchObject({
      task_id: expect.any(String),
      status: 'started',
      message: '决策任务已启动',
    });

    const listed = await client.get('/api/tasks').expect(200);
    expect(listed.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: started.body.task_id,
        type: 'paper_close_decision',
        name: '决策：刷新行情并生成交易计划',
      }),
    ]));

    const task = await waitForTask(client, started.body.task_id);
    expect(task).toMatchObject({
      status: 'completed',
      message: '2026-07-28 收盘决策完成',
      result: { window: 'close', status: 'completed' },
    });
    expect(loadPaperContext).toHaveBeenCalledWith(true, started.body.task_id, { enforceCloseTime: false });
    expect(runWindowConfirmed).toHaveBeenCalledWith('close', context, started.body.task_id);
  });

  it('registers the open window before running it', async () => {
    const tasks = new TaskRegistry(NOOP_AUDIT_LOGGER);
    const context = { rankingDate: '20260728' };
    const loadPaperContext = vi.fn(async () => context);
    const runWindowConfirmed = vi.fn(async () => ({
      ok: true,
      window: 'open',
      trading_date: '20260729',
      status: 'completed',
      results: [],
      message: '2026-07-29 马上下单完成，处理 1 笔策略指令',
    }));
    const app = express();

    registerRoutes(app, {
      store: {} as never,
      tasks,
      paper: { runWindowConfirmed } as never,
      audit: NOOP_AUDIT_LOGGER,
    }, { loadPaperContext } as never, process.cwd());

    const client = request(app);
    const started = await client
      .post('/api/simulated-trading/automation/run-window')
      .send({ window: 'open' })
      .expect(202);

    expect(started.body).toMatchObject({
      task_id: expect.any(String),
      status: 'started',
      message: '开盘执行任务已启动',
    });

    const listed = await client.get('/api/tasks').expect(200);
    expect(listed.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: started.body.task_id,
        type: 'paper_open_window',
        name: '开盘执行：读取账户并提交策略委托',
      }),
    ]));

    const task = await waitForTask(client, started.body.task_id);
    expect(task).toMatchObject({
      status: 'completed',
      message: '2026-07-29 马上下单完成，处理 1 笔策略指令',
      result: { window: 'open', status: 'completed' },
    });
    expect(loadPaperContext).toHaveBeenCalledWith(false, started.body.task_id);
    expect(runWindowConfirmed).toHaveBeenCalledWith('open', context, started.body.task_id);
  });
});
