// 同花顺生命周期守护脚本（独立进程）。
//
// 当模拟交易自动化（server 内 PaperTradingService）开启时：
//   - 收盘策略成功后（close 窗口 status === 'completed'）退出同花顺；
//   - 次日开盘前半小时（09:00–09:25 上海时间）打开同花顺、点登录、
//     切交易页、切模拟 tab，等 server 的 09:31 open 窗口接管。
//
// 进程动作本身由 server/ths-lifecycle.ts 提供，与 server 内置的窗口预热/兜底
// 共用同一份实现和同一把文件锁 —— 两边同时跑 launch-flow 会同时点同一个界面。
// 本脚本只保留"何时动手"的策略：轮询 server 状态 + 按上海时间判断时机。
//
// 运行：npm run ths-lifecycle
// 环境变量：
//   THS_APP_NAME      同花顺进程/应用名（默认 "同花顺"）
//   SERVER_BASE_URL   server API 根地址（默认 http://127.0.0.1:8787）
//   THS_LIFECYCLE_TICK_MS  tick 间隔（默认 30000）
//   THS_LIFECYCLE_TEST     =1 时放宽启动时间窗口，便于白天联调
//
// 仅依赖 Node 标准库 + 项目已有 tsx（可 import server 的 .ts 模块）。

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shanghaiClock, isTradingDay } from '../server/paper-trading/helpers.ts';
import { loadTradingCalendar } from '../server/index-bootstrap.ts';
import { ThsLifecycle, DEFAULT_THS_APP_NAME } from '../server/ths-lifecycle.ts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIFECYCLE_SCRIPT = path.resolve(MODULE_DIR, 'ths_lifecycle.applescript');
const LOG_DIR = path.resolve(MODULE_DIR, '..', 'logs');

const APP_NAME = DEFAULT_THS_APP_NAME;
const SERVER_BASE_URL = (process.env.SERVER_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TICK_MS = Number(process.env.THS_LIFECYCLE_TICK_MS ?? 30_000);
const TEST_MODE = process.env.THS_LIFECYCLE_TEST === '1';
const LOG_FILE = process.env.THS_LIFECYCLE_LOG ?? path.resolve(LOG_DIR, 'ths-lifecycle.log');

// 开盘前启动窗口：09:00（开盘 09:30 前半小时）至 09:25（server 账户同步起点前）。
const LAUNCH_WINDOW_START_MINUTE = 9 * 60; // 540 → 09:00
const LAUNCH_WINDOW_END_MINUTE = 9 * 60 + 25; // 565 → 09:25
const CALENDAR_REFRESH_INTERVAL_MS = 5 * 60_000;

// 确保日志目录存在。
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const log = (stage, message, extra) => {
  const stamp = shanghaiClock(new Date()).timestamp;
  const line = `[ths-lifecycle ${stamp}] ${stage}: ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
};

// ── 进程动作（共享模块） ─────────────────────────────────

const lifecycle = new ThsLifecycle({
  appName: APP_NAME,
  scriptPath: LIFECYCLE_SCRIPT,
  audit: {
    debug: async () => {},
    info: async (component, event, details) => log(event, component, details?.data),
    warn: async (component, event, details) => log(event, component, details?.data),
    error: async (component, event, details) => log(event, component, details?.data),
    query: async () => [],
    files: async () => [],
  },
});

async function quitThs() {
  await lifecycle.quit();
  log('quit', '退出流程结束');
}

async function launchThs() {
  const result = await lifecycle.ensureReady('daemon:pre-open', { timeoutMs: 150_000 });
  log('launch', result.ready ? '同花顺已就绪' : '同花顺未能就绪', {
    launched: result.launched,
    windows: result.probe.windows,
    message: result.message,
  });
  return result.ready;
}

// ── 状态获取（HTTP 轮询 server） ─────────────────────────

let calendarCache;
let calendarLastRefreshMs = 0;

async function ensureCalendar(now) {
  // 每 CALENDAR_REFRESH_INTERVAL_MS 刷新一次；刷新失败时沿用上次缓存。
  if (calendarCache && now - calendarLastRefreshMs < CALENDAR_REFRESH_INTERVAL_MS) {
    return calendarCache;
  }
  try {
    calendarCache = await loadTradingCalendar();
    calendarLastRefreshMs = now;
  } catch (err) {
    log('calendar', '加载交易日历失败，沿用上次缓存', { error: String(err.message || err).slice(0, 200) });
  }
  return calendarCache;
}

async function fetchAutomation() {
  const response = await fetch(`${SERVER_BASE_URL}/api/simulated-trading/automation`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`automation HTTP ${response.status}`);
  const body = await response.json();
  return body; // { automation: { enabled, ... }, schedule: [{window, status, ...}] }
}

// ── 状态机 ───────────────────────────────────────────────

const memory = { date: '', quitDoneDate: '', launchDoneDate: '' };

function rolloverIfNeeded(clock) {
  if (clock.date !== memory.date) {
    memory.date = clock.date;
    memory.quitDoneDate = '';
    memory.launchDoneDate = '';
    log('rollover', '进入新交易日，重置动作标记', { date: clock.date });
  }
}

function closeStatus(automation) {
  const schedule = automation?.schedule;
  if (!Array.isArray(schedule)) return undefined;
  return schedule.find((entry) => entry.window === 'close')?.status;
}

async function tick() {
  const now = Date.now();
  const clock = shanghaiClock(new Date(now));
  rolloverIfNeeded(clock);

  // 日历（本地缓存，每 5min 刷新）。
  const calendar = await ensureCalendar(now);
  if (!isTradingDay(clock, calendar ?? [])) {
    log('tick', '非交易日，跳过', { date: clock.date, weekday: clock.weekday });
    return;
  }

  // 拉自动化状态。server 不可达时只打日志、不动作（宁可不动同花顺）。
  let automation;
  try {
    automation = await fetchAutomation();
  } catch (err) {
    log('tick', '获取自动化状态失败，跳过本 tick', { error: String(err.message || err).slice(0, 200) });
    return;
  }

  if (!automation?.automation?.enabled) {
    log('tick', '自动化未开启，跳过同花顺生命周期动作');
    return;
  }

  // 收盘退出：close 窗口成功后且当天未退出过。
  const closeDone = closeStatus(automation) === 'completed';
  if (closeDone && memory.quitDoneDate !== clock.date) {
    log('tick', '检测到收盘策略已完成，退出同花顺', { close_status: closeStatus(automation) });
    try {
      await quitThs();
      memory.quitDoneDate = clock.date;
    } catch (err) {
      log('quit', '退出同花顺异常', { error: String(err.message || err).slice(0, 200) });
    }
    return;
  }

  // 开盘前启动：09:00–09:25（测试模式下放宽到全天可启动一次，便于联调）。
  const inLaunchWindow =
    TEST_MODE || (clock.minute >= LAUNCH_WINDOW_START_MINUTE && clock.minute < LAUNCH_WINDOW_END_MINUTE);
  if (inLaunchWindow && memory.launchDoneDate !== clock.date) {
    log('tick', '进入开盘前启动窗口，启动同花顺并切模拟', {
      minute: clock.minute,
      test: TEST_MODE,
    });
    try {
      await launchThs();
      memory.launchDoneDate = clock.date;
    } catch (err) {
      log('launch', '启动/登录同花顺异常', { error: String(err.message || err).slice(0, 200) });
    }
    return;
  }

  log('tick', '等待中', {
    minute: clock.minute,
    close_done: closeDone,
    quit_done: memory.quitDoneDate === clock.date,
    launch_done: memory.launchDoneDate === clock.date,
  });
}

// ── 调度 ─────────────────────────────────────────────────

log('start', '同花顺生命周期守护启动', {
  app: APP_NAME,
  server: SERVER_BASE_URL,
  tick_ms: TICK_MS,
  test_mode: TEST_MODE,
  log_file: LOG_FILE,
  script: LIFECYCLE_SCRIPT,
});

// 首次立即跑一次，之后按间隔。
guardTick();
setInterval(guardTick, TICK_MS);

function guardTick() {
  tick().catch((err) => {
    log('tick', 'tick 未捕获异常', { error: String(err && err.stack ? err.stack : err).slice(0, 500) });
  });
}
