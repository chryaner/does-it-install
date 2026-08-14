import { defineConfig } from 'vitest/config';

// Smoke tests hit the network and install real packages. Run separately:
//   npm run test:smoke
export default defineConfig({
  test: {
    include: ['src/**/*.smoke.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
