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

function portIsOpen(port) {
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

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

trackProcess(spawn('tsx', ['server/index.ts'], { stdio: 'inherit', env: process.env }), 'server');

try {
  await waitForApi(Number(process.env.PORT ?? 8787));
  if (!shuttingDown) {
    // lifecycle 依赖 server 的自动化 API，因此必须在 API 就绪后启动。
    trackProcess(
      spawn('tsx', ['scripts/ths-lifecycle.mjs'], { stdio: 'inherit', env: process.env }),
      'ths-lifecycle',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
