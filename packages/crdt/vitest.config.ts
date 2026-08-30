import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@raci/crdt',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
