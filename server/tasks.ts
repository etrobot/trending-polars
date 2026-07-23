import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { TaskSnapshot, TaskStatus } from '../src/types.js';
import { guardDetachedPromise, NOOP_AUDIT_LOGGER, type AuditLoggerLike } from './audit-log.js';
import { formatDateTime } from './format.js';

type TaskRunner = (context: {
  traceId: string;
  progress: (value: number, message: string) => void;
  cancelled: () => boolean;
}) => Promise<unknown>;

interface InternalTask extends TaskSnapshot {
  cancelRequested: boolean;
}

export class TaskRegistry extends EventEmitter {
  private readonly tasks = new Map<string, InternalTask>();

  constructor(private readonly audit: AuditLoggerLike = NOOP_AUDIT_LOGGER) {
    super();
  }

  recent(limit = 50, stripResult = true): TaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((task) => this.publicTask(task, stripResult));
  }

  get(id: string): TaskSnapshot | null {
    const task = this.tasks.get(id);
    return task ? this.publicTask(task, false) : null;
  }

  start(type: string, name: string, runner: TaskRunner): TaskSnapshot {
    const now = formatDateTime();
    const task: InternalTask = {
      id: randomUUID(),
      type,
      name,
      status: 'pending',
      progress: 0,
      message: '等待执行',
      created_at: now,
      updated_at: now,
      cancelRequested: false,
    };
    task.trace_id = task.id;
    this.tasks.set(task.id, task);
    guardDetachedPromise(this.audit.info('task', 'task_created', {
      traceId: task.id,
      data: { task_type: task.type, task_name: task.name },
    }), 'task', 'task_created');
    this.broadcast(task);
    queueMicrotask(() => {
      guardDetachedPromise(this.run(task, runner), 'task', 'task_runner');
    });
    return this.publicTask(task, true);
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || !['pending', 'running'].includes(task.status)) return false;
    task.cancelRequested = true;
    task.message = '正在停止…';
    task.updated_at = formatDateTime();
    this.broadcast(task);
    guardDetachedPromise(this.audit.warn('task', 'task_cancel_requested', {
      traceId: task.trace_id ?? task.id,
      data: { task_type: task.type, progress: task.progress },
    }), 'task', 'task_cancel_requested');
    return true;
  }

  private async run(task: InternalTask, runner: TaskRunner): Promise<void> {
    this.update(task, 'running', 1, '任务已启动');
    try {
      const result = await runner({
        traceId: task.trace_id ?? task.id,
        progress: (value, message) => {
          if (!task.cancelRequested) this.update(task, 'running', value, message);
        },
        cancelled: () => task.cancelRequested,
      });
      if (task.cancelRequested) {
        this.update(task, 'cancelled', task.progress, '任务已停止');
        await this.audit.warn('task', 'task_cancelled', {
          traceId: task.trace_id ?? task.id,
          data: { task_type: task.type, progress: task.progress },
        });
        return;
      }
      task.result = result;
      this.update(task, 'completed', 100, '完成');
      await this.audit.info('task', 'task_completed', {
        traceId: task.trace_id ?? task.id,
        data: { task_type: task.type, result },
      });
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error);
      this.update(task, 'failed', task.progress, task.error);
      await this.audit.error('task', 'task_failed', {
        traceId: task.trace_id ?? task.id,
        data: { task_type: task.type, progress: task.progress },
        error,
      });
    }
  }

  private update(task: InternalTask, status: TaskStatus, progress: number, message: string): void {
    task.status = status;
    task.progress = Math.min(100, Math.max(0, Math.round(progress)));
    task.message = message;
    task.updated_at = formatDateTime();
    this.broadcast(task);
    guardDetachedPromise(this.audit.debug('task', 'task_progress', {
      traceId: task.trace_id ?? task.id,
      data: { task_type: task.type, status, progress: task.progress, message },
    }), 'task', 'task_progress');
  }

  private publicTask(task: InternalTask, stripResult: boolean): TaskSnapshot {
    const { cancelRequested: _cancelRequested, ...snapshot } = task;
    if (stripResult) {
      const { result: _result, ...withoutResult } = snapshot;
      return { ...withoutResult };
    }
    return { ...snapshot };
  }

  private broadcast(task: InternalTask): void {
    this.emit('update', { type: 'update', task: this.publicTask(task, true) });
  }
}
