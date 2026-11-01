import { spawn } from 'node:child_process';
import net from 'node:net';

const processes = [];

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) child.kill('SIGTERM');
  process.exit(code);
};

function trackProcess(child, label) {
  processes.push(child);
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0 && signal !== 'SIGTERM') {
      console.error(`${label} 已退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

// Windows 下 tsx / vite 是 .cmd 包装脚本，spawn 必须经由 shell 才能解析 PATH。
const spawnOptions = { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' };

const watchServer = trackProcess(
  spawn('tsx', ['watch', 'server/index.ts'], spawnOptions),
  'server',
);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForApi(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!shuttingDown && Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`API 未在 ${timeoutMs / 1000} 秒内监听 ${port} 端口`);
}

try {
  // API 未准备好时不启动 Vite，避免浏览器立即重连 WebSocket 产生 EPIPE 洪水。
  await waitForApi(Number(process.env.PORT ?? 8787));
  if (!shuttingDown) {
    // lifecycle 依赖 server 的自动化 API；API 就绪后再启动，避免首个 tick 因连接失败跳过。
    // 该脚本用 AppleScript 操作同花顺，仅 macOS 可用。
    if (process.platform === 'darwin') {
      trackProcess(
        spawn('tsx', ['scripts/ths-lifecycle.mjs'], spawnOptions),
        'ths-lifecycle',
      );
    }
    trackProcess(spawn('vite', [], spawnOptions), 'vite');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
