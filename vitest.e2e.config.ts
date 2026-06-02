import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/__tests__/e2e/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
