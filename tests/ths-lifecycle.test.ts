import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ThsLifecycle,
  parseThsProbe,
  type ThsLifecycleCommand,
  type ThsLifecycleRunner,
} from '../server/ths-lifecycle.js';

/** 记录每一步动作，用于断言"是否真的去点了界面"。 */
class FakeRunner implements ThsLifecycleRunner {
  readonly calls: string[] = [];
  /** 每次 probe 依次返回的结果；用尽后重复最后一个。 */
  probeQueue: string[] = ['THS_PROBE|running=true|windows=2'];
  launchFlowResult: string | Error = 'LAUNCH_FLOW_DONE|已进入同花顺模拟交易页';
  private probeIndex = 0;

  async runScript(command: ThsLifecycleCommand, _timeoutMs: number): Promise<string> {
    this.calls.push(command);
    if (command === 'probe') {
      const value = this.probeQueue[Math.min(this.probeIndex, this.probeQueue.length - 1)];
      this.probeIndex += 1;
      return value;
    }
    if (command === 'launch-flow') {
      if (this.launchFlowResult instanceof Error) throw this.launchFlowResult;
      return this.launchFlowResult;
    }
    return 'QUIT_OK|同花顺已退出';
  }

  async openApp(appName: string): Promise<void> {
    this.calls.push(`open:${appName}`);
  }

  async killApp(appName: string): Promise<void> {
    this.calls.push(`kill:${appName}`);
  }

  /** 重设探测序列并把游标归零。 */
  queueProbes(...outputs: string[]) {
    this.probeQueue = outputs;
    this.probeIndex = 0;
  }
}

describe('同花顺生命周期', () => {
  let dir = '';
  let lockPath = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ths-lifecycle-'));
    lockPath = path.join(dir, 'ths-lifecycle.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const build = (runner: ThsLifecycleRunner) => new ThsLifecycle({ runner, lockPath, appName: '同花顺' });

  it('parseThsProbe 把进程状态和窗口数解析成 ready', () => {
    expect(parseThsProbe('THS_PROBE|running=true|windows=2')).toEqual({ running: true, windows: 2, ready: true });
    expect(parseThsProbe('THS_PROBE|running=true|windows=0')).toEqual({ running: true, windows: 0, ready: false });
    expect(parseThsProbe('THS_PROBE|running=false|windows=0')).toEqual({ running: false, windows: 0, ready: false });
  });

  it('已就绪时只探测一次，不启动也不点界面', async () => {
    const runner = new FakeRunner();
    const result = await build(runner).ensureReady('window:open');

    expect(result).toMatchObject({ ready: true, launched: false });
    expect(runner.calls).toEqual(['probe']);
  });

  it('进程不在时依次 open -a → launch-flow → 复探', async () => {
    const runner = new FakeRunner();
    runner.probeQueue = [
      'THS_PROBE|running=false|windows=0', // 首次探测
      'THS_PROBE|running=false|windows=0', // 锁内复探
      'THS_PROBE|running=true|windows=1', // waitForRunning
      'THS_PROBE|running=true|windows=2', // launch-flow 之后
    ];

    const result = await build(runner).ensureReady('window:open');

    expect(result).toMatchObject({ ready: true, launched: true });
    expect(runner.calls.filter((call) => call !== 'probe')).toEqual(['open:同花顺', 'launch-flow']);
  });

  it('进程在但读不到窗口时仍跑 launch-flow（7-29/7-30 的真实故障形态）', async () => {
    const runner = new FakeRunner();
    runner.probeQueue = [
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=3',
    ];

    const result = await build(runner).ensureReady('window:open');

    expect(result).toMatchObject({ ready: true, launched: false });
    // 进程已在，不该再 open -a，但必须把界面点回来
    expect(runner.calls).not.toContain('open:同花顺');
    expect(runner.calls).toContain('launch-flow');
  });

  it('launch-flow 失败时如实回报未就绪，不抛错', async () => {
    const runner = new FakeRunner();
    runner.probeQueue = ['THS_PROBE|running=true|windows=0'];
    runner.launchFlowResult = new Error('LOGIN_PENDING|等待主交易界面超时（可能登录需手输或弹验证）');

    const result = await build(runner).ensureReady('window:open');

    expect(result.ready).toBe(false);
    expect(result.message).toContain('LOGIN_PENDING');
  });

  it('锁被别的活进程占住时不重复拉起，只回报探测结果', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, reason: 'daemon', started_at: '' }), 'utf8');
    const runner = new FakeRunner();
    runner.probeQueue = ['THS_PROBE|running=true|windows=0'];

    const result = await build(runner).ensureReady('window:open');

    expect(result).toMatchObject({ ready: false, launched: false });
    expect(result.message).toContain('其它进程');
    expect(runner.calls).not.toContain('launch-flow');
    expect(runner.calls).not.toContain('open:同花顺');
  });

  it('陈旧锁（超 5 分钟）可被夺取', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, reason: 'crashed', started_at: '' }), 'utf8');
    const stale = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, stale, stale);
    const runner = new FakeRunner();
    runner.probeQueue = [
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=2',
    ];

    const result = await build(runner).ensureReady('window:open');

    expect(result.ready).toBe(true);
    expect(runner.calls).toContain('launch-flow');
  });

  it('持有者进程已消失的锁可被夺取', async () => {
    // pid 99999999 超出 macOS pid 上限，必定不存在
    await writeFile(lockPath, JSON.stringify({ pid: 99_999_999, reason: 'gone', started_at: '' }), 'utf8');
    const runner = new FakeRunner();
    runner.probeQueue = [
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=2',
    ];

    const result = await build(runner).ensureReady('window:open');

    expect(result.ready).toBe(true);
    expect(runner.calls).toContain('launch-flow');
  });

  it('拉起结束后释放锁，后续调用可以再次拉起', async () => {
    const runner = new FakeRunner();
    const notReadyThenReady = [
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=0',
      'THS_PROBE|running=true|windows=2',
    ];
    runner.queueProbes(...notReadyThenReady);
    const lifecycle = build(runner);

    await lifecycle.ensureReady('window:open');
    runner.queueProbes(...notReadyThenReady);
    const second = await lifecycle.ensureReady('window:near_close');

    expect(second.ready).toBe(true);
    expect(runner.calls.filter((call) => call === 'launch-flow')).toHaveLength(2);
  });

  it('quit 在 AppleScript 退不掉时用 pkill 兜底', async () => {
    const runner = new FakeRunner();
    runner.probeQueue = [
      'THS_PROBE|running=true|windows=2', // quit 入口探测
      'THS_PROBE|running=true|windows=2', // quit 脚本之后仍在
      'THS_PROBE|running=false|windows=0', // pkill 之后
    ];

    await build(runner).quit();

    expect(runner.calls).toContain('quit');
    expect(runner.calls).toContain('kill:同花顺');
  });

  it('同花顺本来就没在跑时 quit 不做任何动作', async () => {
    const runner = new FakeRunner();
    runner.probeQueue = ['THS_PROBE|running=false|windows=0'];

    await build(runner).quit();

    expect(runner.calls).toEqual(['probe']);
  });
});
