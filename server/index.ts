import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { loadTradingCalendar } from './index-bootstrap.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// 极简 .env 加载（项目无 dotenv）：先项目根 trending-polars/.env，再工作区根 .env；不覆盖已有变量。
function loadEnvFiles() {
  const candidates = [
    path.resolve(MODULE_DIR, '..', '.env'),
    path.resolve(MODULE_DIR, '..', '..', '.env'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, '');
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}
loadEnvFiles();

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

async function main() {
  const { app, services } = createApp();
  const server = createServer(app);
  const taskSockets = new WebSocketServer({ noServer: true });
  const paperSockets = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    const target = pathname === '/ws/tasks' ? taskSockets : pathname === '/ws/simulated-trading' ? paperSockets : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(request, socket, head, (webSocket) => target.emit('connection', webSocket, request));
  });

  taskSockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'snapshot', tasks: services.tasks.recent(50, true) }));
    const onUpdate = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    services.tasks.on('update', onUpdate);
    socket.on('close', () => services.tasks.off('update', onUpdate));
  });

  paperSockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', connected: true }));
    const onUpdate = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    services.paper.on('update', onUpdate);
    socket.on('close', () => services.paper.off('update', onUpdate));
  });

  const initialCalendar = await loadTradingCalendar().catch(() => [] as string[]);
  if (initialCalendar.length) {
    services.paper.setTradingCalendar(initialCalendar);
  }

  services.paper.startScheduler();
  server.on('close', () => {
    services.paper.stopScheduler();
    services.store.close();
  });

  server.listen(port, host, () => {
    console.log(`Trending Polars API listening on http://${host}:${port}`);
  });
}

void main();
