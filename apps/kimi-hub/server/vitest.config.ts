import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-hub-server',
    include: ['test/**/*.test.ts'],
  },
});
