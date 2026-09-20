import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'test/browser/**'],
    setupFiles: ['./test/setup.ts'],
    globals: false,
    env: { TZ: 'Asia/Shanghai' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: { statements: 97.1, lines: 97.1, branches: 86.9, functions: 80.5 },
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/main.tsx', 'src/**/types.ts', 'src/*/index.ts'],
    },
  },
});
