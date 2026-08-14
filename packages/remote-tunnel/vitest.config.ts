import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'remote-tunnel',
    include: ['test/**/*.test.ts'],
  },
});
