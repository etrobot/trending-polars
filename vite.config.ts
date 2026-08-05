import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'suppress-ws-proxy-epipe',
      configureServer(server) {
        // Vite 的 http-proxy 会在后端重启/浏览器主动断开时记录 EPIPE，
        // 这是开发期 WebSocket 重连的正常中间状态，不应刷屏。
        const logger = server.config.logger;
        const originalError = logger.error.bind(logger);
        logger.error = (message, options) => {
          if (
            typeof message === 'string'
            && /ws proxy (?:error|socket error):/.test(message)
            && /EPIPE|ECONNRESET|ECONNREFUSED|socket hang up/.test(message)
          ) return;
          originalError(message, options);
        };
        server.httpServer?.on('upgrade', (req, socket) => {
          socket.on('error', (err: NodeJS.ErrnoException) => {
            if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
            console.error('WebSocket error:', err);
          });
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
    /**
     * Exclude docs/ from the Vite watcher so that editing markdown files
     * in docs/ does not trigger re-compilation or break HMR.
     */
    watch: {
      ignored: ['docs/**'],
    },
  },
  build: {
    sourcemap: true,
  },
});
