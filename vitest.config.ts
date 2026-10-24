import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['apps/**/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'] } },
      { test: { name: 'integration', environment: 'node', include: ['apps/**/tests/integration/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
