import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@raci/core',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
