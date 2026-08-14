import { builtinModules } from 'node:module';

import { defineConfig } from 'tsdown';

const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function shouldAlwaysBundle(id: string): boolean {
  return !builtins.has(id) && !id.startsWith('node:');
}

/**
 * SEA packaging bundle: single fully-self-contained CJS entry (Sea mains must
 * be CommonJS), unlike `tsdown.config.ts` which keeps third-party deps
 * external for `node dist/main.mjs` with node_modules present.
 */
export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['cjs'],
  outDir: 'dist-native/intermediates',
  clean: true,
  dts: false,
  fixedExtension: true,
  hash: false,
  platform: 'node',
  target: 'node24',
  deps: {
    alwaysBundle: shouldAlwaysBundle,
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.cjs',
  },
  checks: {
    legacyCjs: false,
  },
});
