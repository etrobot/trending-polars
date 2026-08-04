// 同花顺进程生命周期：探测、按需拉起（登录 + 切模拟交易页）、优雅退出。
//
// server（PaperTradingService 窗口预热/兜底）和独立守护脚本
// scripts/ths-lifecycle.mjs 共用这一份实现，并共用同一把文件锁 ——
// 两边同时跑 launch-flow 会同时点同一个界面，必须互斥。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOOP_AUDIT_LOGGER, type AuditLoggerLike } from './audit-log.js';
import { DEFAULT_DATA_DIR } from './data-store.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_THS_LIFECYCLE_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'ths_lifecycle.applescript');
export const DEFAULT_THS_APP_NAME = process.env.THS_APP_NAME ?? '同花顺';

/** 默认就绪预算：一次完整的 open -a + 登录 + 切模拟 tab。 */
export const DEFAULT_ENSURE_READY_TIMEOUT_MS = 120_000;
/** 锁超过这个时长即视为陈旧（持有者崩溃或被 kill），可被夺取。 */
const LOCK_STALE_MS = 5 * 60_000;
/** 等进程出现最多等这么久，且不超过整体预算。 */
const WAIT_FOR_RUNNING_MS = 30_000;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 15_000;
const QUIT_TIMEOUT_MS = 20_000;

export type ThsLifecycleCommand = 'probe' | 'launch-flow' | 'quit';

export interface ThsProbe {
  running: boolean;
  windows: number;
  /** 进程活着还不够：窗口数为 0 时下单脚本一样读不到界面。 */
  ready: boolean;
}

export interface ThsReadyResult {
  ready: boolean;
  /** 本次调用是否真的执行了拉起动作（用于区分"本来就好"和"救回来了"）。 */
  launched: boolean;
  probe: ThsProbe;
  message?: string;
}

export interface ThsLifecycleRunner {
  runScript(command: ThsLifecycleCommand, timeoutMs: number): Promise<string>;
  openApp(appName: string): Promise<void>;
  killApp(appName: string): Promise<void>;
}

export interface ThsLifecycleOptions {
  appName?: string;
  scriptPath?: string;
  lockPath?: string;
  runner?: ThsLifecycleRunner;
  audit?: AuditLoggerLike;
  now?: () => Date;
}

export function parseThsProbe(output: string): ThsProbe {
  const running = /running=true/i.test(output);
  const windows = Number(/windows=(\d+)/i.exec(output)?.[1] ?? '0');
  const windowCount = Number.isFinite(windows) ? windows : 0;
  return { running, windows: windowCount, ready: running && windowCount > 0 };
}

function defaultRunner(scriptPath: string): ThsLifecycleRunner {
  return {
    runScript(command, timeoutMs) {
      if (!existsSync(scriptPath)) {
        return Promise.reject(new Error(`同花顺 lifecycle AppleScript 不存在：${scriptPath}`));
      }
      return new Promise((resolve, reject) => {
        execFile('osascript', [scriptPath, command], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
          if (error) {
            const failure = error as Error & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number | null };
            const timedOut = failure.killed || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT';
            reject(new Error(timedOut
              ? `同花顺 lifecycle AppleScript 超时（${Math.round(timeoutMs / 1000)}s）：${command}`
              : String(stderr || stdout || error.message).trim()));
            return;
          }
          resolve(String(stdout).trim());
        });
      });
    },
    openApp(appName) {
      return new Promise((resolve, reject) => {
        execFile('open', ['-a', appName], (error) => (error ? reject(error) : resolve()));
      });
    },
    killApp(appName) {
      // pkill 在没有匹配进程时返回非 0，这里不关心，只求最终进程消失。
      return new Promise((resolve) => {
        execFile('pkill', ['-x', appName], () => resolve());
      });
    },
  };
}

export class ThsLifecycle {
  private readonly appName: string;
  private readonly lockPath: string;
  private readonly runner: ThsLifecycleRunner;
  private readonly audit: AuditLoggerLike;
  private readonly now: () => Date;
  private lockHeld = false;
  /** probe 只能确认有窗口；首次接管仍必须跑一次登录/交易页/模拟 tab 流程。 */
  private flowReady = false;

  constructor(options: ThsLifecycleOptions = {}) {
    this.appName = options.appName ?? DEFAULT_THS_APP_NAME;
    this.lockPath = options.lockPath ?? path.join(DEFAULT_DATA_DIR, 'runtime', 'ths-lifecycle.lock');
    this.runner = options.runner ?? defaultRunner(options.scriptPath ?? DEFAULT_THS_LIFECYCLE_SCRIPT);
    this.audit = options.audit ?? NOOP_AUDIT_LOGGER;
    this.now = options.now ?? (() => new Date());
  }

  async probe(): Promise<ThsProbe> {
    try {
      return parseThsProbe(await this.runner.runScript('probe', PROBE_TIMEOUT_MS));
    } catch (error) {
      await this.audit.warn('ths_lifecycle', 'probe_failed', { error });
      return { running: false, windows: 0, ready: false };
    }
  }

  /**
   * 保证同花顺处于"进程在跑且有可交互窗口"的状态。已就绪时只花一次 probe（约 300ms）。
   * 拿不到锁说明别的进程正在拉起，此时只回报观测结果，绝不重复点界面。
   */
  async ensureReady(reason: string, options: { timeoutMs?: number } = {}): Promise<ThsReadyResult> {
    const budgetMs = Math.max(5_000, options.timeoutMs ?? DEFAULT_ENSURE_READY_TIMEOUT_MS);
    const deadline = this.now().getTime() + budgetMs;

    const initial = await this.probe();
    if (initial.ready && this.flowReady) return { ready: true, launched: false, probe: initial };

    if (!(await this.acquireLock(reason))) {
      const observed = await this.probe();
      return {
        ready: observed.ready,
        launched: false,
        probe: observed,
        message: '同花顺拉起正由其它进程执行，本次跳过',
      };
    }

    try {
      // 锁内复探：排队等锁期间对方可能已经拉好了。
      let current = await this.probe();
      if (current.ready && this.flowReady) return { ready: true, launched: false, probe: current };

      let launched = false;
      if (!current.running) {
        await this.audit.info('ths_lifecycle', 'launching', { data: { reason, app: this.appName } });
        await this.runner.openApp(this.appName);
        launched = true;
        current = await this.waitForRunning(deadline);
        if (!current.running) {
          return { ready: false, launched, probe: current, message: 'open -a 后同花顺进程未出现' };
        }
      }

      const remainingMs = deadline - this.now().getTime();
      if (remainingMs <= 0) {
        return { ready: false, launched, probe: current, message: '就绪预算已用尽，未执行 launch-flow' };
      }

      // 进程在但没有可用窗口（最小化 / 其它 Space / 刚启动）→ 登录 + 切交易页 + 切模拟 tab。
      let message: string | undefined;
      let launchFlowSucceeded = false;
      try {
        message = await this.runner.runScript('launch-flow', remainingMs);
        launchFlowSucceeded = true;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        await this.audit.warn('ths_lifecycle', 'launch_flow_failed', { data: { reason }, error });
      }

      const final = await this.probe();
      const ready = launchFlowSucceeded && final.ready;
      this.flowReady = ready;
      await this.audit.info('ths_lifecycle', 'ensure_ready_finished', {
        data: { reason, ready, launched, windows: final.windows, message },
      });
      return { ready, launched, probe: final, message };
    } finally {
      await this.releaseLock();
    }
  }

  /** 优雅退出，超时用 pkill 兜底。有人正在拉起时不去关。 */
  async quit(): Promise<void> {
    if (!(await this.probe()).running) {
      this.flowReady = false;
      return;
    }
    if (!(await this.acquireLock('quit'))) {
      await this.audit.info('ths_lifecycle', 'quit_skipped_locked', {});
      return;
    }
    try {
      try {
        await this.runner.runScript('quit', QUIT_TIMEOUT_MS);
      } catch (error) {
        await this.audit.warn('ths_lifecycle', 'quit_script_failed', { error });
      }
      if (!(await this.probe()).running) {
        this.flowReady = false;
        return;
      }
      await this.runner.killApp(this.appName);
      const deadline = this.now().getTime() + 10_000;
      while (this.now().getTime() < deadline) {
        if (!(await this.probe()).running) return;
        await delay(PROBE_INTERVAL_MS);
      }
      await this.audit.warn('ths_lifecycle', 'quit_incomplete', { data: { app: this.appName } });
    } finally {
      await this.releaseLock();
    }
  }

  private async waitForRunning(deadline: number): Promise<ThsProbe> {
    const limit = Math.min(deadline, this.now().getTime() + WAIT_FOR_RUNNING_MS);
    let current = await this.probe();
    while (!current.running && this.now().getTime() < limit) {
      await delay(PROBE_INTERVAL_MS);
      current = await this.probe();
    }
    return current;
  }

  private async acquireLock(reason: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({
            pid: process.pid,
            reason,
            started_at: this.now().toISOString(),
          }), 'utf8');
        } finally {
          await handle.close();
        }
        this.lockHeld = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          await this.audit.warn('ths_lifecycle', 'lock_acquire_failed', { error });
          return false;
        }
        if (!(await this.reclaimStaleLock())) return false;
      }
    }
    return false;
  }

  private async reclaimStaleLock(): Promise<boolean> {
    try {
      const stats = await stat(this.lockPath);
      const info = await readFile(this.lockPath, 'utf8')
        .then((text) => JSON.parse(text) as { pid?: unknown })
        .catch(() => null);
      const pid = Number(info?.pid);
      const holderAlive = Number.isInteger(pid) && pid > 0 && processAlive(pid);
      const ageMs = this.now().getTime() - stats.mtimeMs;
      if (holderAlive && ageMs < LOCK_STALE_MS) return false;
      await unlink(this.lockPath);
      await this.audit.warn('ths_lifecycle', 'stale_lock_reclaimed', {
        data: { holder_pid: pid, age_ms: Math.round(ageMs), holder_alive: holderAlive },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    await unlink(this.lockPath).catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但不归当前用户管。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
