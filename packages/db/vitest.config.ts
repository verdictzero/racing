import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@raci/db',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
