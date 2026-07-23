import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
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

services.paper.startScheduler();
server.on('close', () => {
  services.paper.stopScheduler();
  services.store.close();
});

server.listen(port, host, () => {
  console.log(`Trending Polars API listening on http://${host}:${port}`);
});
