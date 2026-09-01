import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@raci/web',
    // Server-side units only. The Vue screens need a browser to mean anything, and a jsdom
    // approximation of one would test the approximation.
    include: ['server/**/*.test.ts'],
    environment: 'node',
  },
});
