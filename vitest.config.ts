import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/__tests__/**/*.test.ts'],
    exclude: ['**/e2e/**', '**/node_modules/**'],
  },
});
