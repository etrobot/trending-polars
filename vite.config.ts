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
  },
  build: {
    sourcemap: true,
  },
});
