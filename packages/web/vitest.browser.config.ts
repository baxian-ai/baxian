import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['react', 'react-dom/client', 'react-router-dom', '@testing-library/react'],
  },
  test: {
    include: ['test/browser/**/*.test.{ts,tsx}'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      screenshotFailures: false,
      viewport: { width: 800, height: 900 },
      instances: [{ browser: 'chromium' }],
    },
  },
});
