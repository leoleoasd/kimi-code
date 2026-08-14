import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/hub/index.ts', './src/agent/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
