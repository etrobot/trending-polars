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

const watchServer = spawn('tsx', ['watch', 'server/index.ts'], { stdio: 'inherit', env: process.env });
processes.push(watchServer);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const child of processes) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0 && signal !== 'SIGTERM') shutdown(code ?? 1);
  });
}

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
    const vite = spawn('vite', [], { stdio: 'inherit', env: process.env });
    processes.push(vite);
    vite.on('exit', (code, signal) => {
      if (!shuttingDown && (code ?? 0) !== 0 && signal !== 'SIGTERM') shutdown(code ?? 1);
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  shutdown(1);
}
