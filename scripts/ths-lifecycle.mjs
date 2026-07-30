// 同花顺生命周期守护脚本（独立进程）。
//
// 当模拟交易自动化（server 内 PaperTradingService）开启时：
//   - 收盘策略成功后（close 窗口 status === 'completed'）退出同花顺；
//   - 次日开盘前半小时（09:00–09:25 上海时间）打开同花顺、点登录、
//     切交易页、切模拟 tab，等 server 的 09:31 open 窗口接管。
//
// 设计为独立进程，不嵌入 server：通过 HTTP 轮询 server 的自动化 API 拿状态，
// 避免与 server 进程耦合。每 30s 一个 tick，按上海时间判断当天是否已完成
// 退出/启动，用日期 key 去重（参考 server 的 completed_windows 思路）。
//
// 运行：npm run ths-lifecycle
// 环境变量：
//   THS_APP_NAME      同花顺进程/应用名（默认 "同花顺"）
//   SERVER_BASE_URL   server API 根地址（默认 http://127.0.0.1:8787）
//   THS_LIFECYCLE_TICK_MS  tick 间隔（默认 30000）
//   THS_LIFECYCLE_TEST     =1 时放宽启动时间窗口，便于白天联调
//
// 仅依赖 Node 标准库 + 项目已有 tsx（可 import server 的 .ts 模块）。

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shanghaiClock, isTradingDay } from '../server/paper-trading/helpers.ts';
import { loadTradingCalendar } from '../server/index-bootstrap.ts';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIFECYCLE_SCRIPT = path.resolve(MODULE_DIR, 'ths_lifecycle.applescript');
const LOG_DIR = path.resolve(MODULE_DIR, '..', 'logs');

const APP_NAME = process.env.THS_APP_NAME ?? '同花顺';
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

// ── 进程动作 ─────────────────────────────────────────────

function procExists(name) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application "System Events" to exists process "${name}"`], (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).trim().toLowerCase() === 'true');
    });
  });
}

// 先 osascript quit，超时未退则 pkill 兜底。幂等：已退出直接成功。
async function quitThs() {
  if (!(await procExists(APP_NAME))) {
    log('quit', '同花顺未在运行，跳过', { app: APP_NAME });
    return;
  }
  // 走 AppleScript 的 quit 子命令：内部已做前台置顶 + tell quit + 等待轮询。
  await runAppleScript('quit', 20_000).catch((err) => {
    log('quit', 'AppleScript quit 失败，将用 pkill 兜底', { error: String(err.message || err).slice(0, 200) });
  });
  if (!(await procExists(APP_NAME))) {
    log('quit', '同花顺已退出（osascript quit）');
    return;
  }
  // 兜底：pkill 强杀。
  await new Promise((resolve) => {
    execFile('pkill', ['-x', APP_NAME], (err) => {
      resolve(err);
    });
  });
  // 等待进程消失，最多 ~10s。
  for (let i = 0; i < 50; i++) {
    if (!(await procExists(APP_NAME))) break;
    await sleep(0.2);
  }
  if (await procExists(APP_NAME)) {
    log('quit', 'pkill 后同花顺仍存在', { app: APP_NAME });
  } else {
    log('quit', '同花顺已退出（pkill 兜底）');
  }
}

async function launchThs() {
  if (await procExists(APP_NAME)) {
    log('launch', '同花顺已在运行，仅做登录+切模拟流程', { app: APP_NAME });
  } else {
    await new Promise((resolve, reject) => {
      execFile('open', ['-a', APP_NAME], (err) => (err ? reject(err) : resolve()));
    });
    // 等进程出现，最多 ~30s。
    for (let i = 0; i < 150; i++) {
      if (await procExists(APP_NAME)) break;
      await sleep(0.2);
    }
    if (!(await procExists(APP_NAME))) {
      log('launch', 'open 启动后同花顺进程未出现', { app: APP_NAME });
      return;
    }
    log('launch', '同花顺已启动，开始登录+切模拟流程');
  }
  // AppleScript 登录 + 切交易页 + 切模拟 tab。失败仅记日志，不视为硬失败。
  const result = await runAppleScript('launch-flow', 120_000);
  log('launch', result || 'launch-flow 完成');
}

function runAppleScript(subcommand, timeoutMs) {
  if (!existsSync(LIFECYCLE_SCRIPT)) {
    return Promise.reject(new Error(`同花顺 lifecycle AppleScript 不存在：${LIFECYCLE_SCRIPT}`));
  }
  return new Promise((resolve, reject) => {
    execFile('osascript', [LIFECYCLE_SCRIPT, subcommand], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const killed = error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
        const message = killed
          ? `AppleScript 执行超时（${Math.round(timeoutMs / 1000)}s）：${subcommand}`
          : String(stderr || stdout || error.message).trim();
        reject(new Error(message));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
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

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

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
