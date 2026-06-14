import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules/')) return undefined;
          if (id.includes('node_modules/@xterm/')) return 'xterm';
          if (id.includes('node_modules/react-router') || id.includes('node_modules/@remix-run/')) {
            return 'router';
          }
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 8123,
    // Fail fast on port conflict instead of silently jumping to 8124+; ops docs
    // (`lsof -iTCP:8123`) and systemd unit both assume vite actually binds to 8123.
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        ws: true,
      },
      '/health': {
        target: 'http://localhost:3000',
      },
    },
  },
});
