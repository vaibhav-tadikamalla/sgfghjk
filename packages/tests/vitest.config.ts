import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: [
      'unit/**/*.test.ts',
      'integration/**/*.test.ts',
      'stress/**/*.test.ts',
      'fuzz/**/*.test.ts',
    ],
  },
});
