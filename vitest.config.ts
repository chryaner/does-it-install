import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.smoke.test.ts', 'node_modules/**'],
    testTimeout: 20_000,
  },
});
