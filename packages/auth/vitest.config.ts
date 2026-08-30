import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@raci/auth',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
