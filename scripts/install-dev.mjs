#!/usr/bin/env node
/**
 * `pnpm run install:local` — rebuild the kimi CLI + hub native SEA binaries
 * and install them into `~/.kimi-code/bin/` (the PATH dir the dev loop uses).
 *
 * Install is atomic (temp file + rename) so already-running instances keep
 * their old inode and are not disturbed — no need to kill running sessions.
 */

import { execFile } from 'node:child_process';
import { copyFile, chmod, mkdir, rename } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);

const TRIPLES = {
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
};

const triple = TRIPLES[`${platform()}-${arch()}`];
if (triple === undefined) {
  console.error(`unsupported host: ${platform()}-${arch()}`);
  process.exit(1);
}

function run(args, cwd = repoRoot) {
  return new Promise((resolveRun, reject) => {
    execFile(args[0], args.slice(1), { cwd, stdio: 'inherit' }, (error) => {
      if (error !== null) reject(error);
      else resolveRun();
    });
  });
}

const targets = [
  {
    name: 'kimi',
    build: [['pnpm', '--filter', '@moonshot-ai/kimi-code', 'run', 'build:native:sea']],
    bin: join(repoRoot, 'apps/kimi-code/dist-native/bin', triple, 'kimi'),
  },
  {
    name: 'kimi-hub',
    // The SEA embeds the web bundle, so the web (and its server deps) must be
    // built BEFORE the native collector reads `web/dist`.
    build: [
      ['pnpm', '--filter', '@moonshot-ai/kimi-hub-web', 'run', 'build'],
      ['pnpm', '--filter', '@moonshot-ai/kimi-hub-server', 'run', 'build'],
      ['pnpm', '--filter', '@moonshot-ai/kimi-hub-server', 'run', 'build:native'],
    ],
    bin: join(repoRoot, 'apps/kimi-hub/server/dist-native/bin', triple, 'kimi-hub'),
  },
];

async function install(target) {
  const binDir = join(homedir(), '.kimi-code', 'bin');
  const out = join(binDir, target.name);
  await mkdir(binDir, { recursive: true });
  const tmp = join(binDir, `.${target.name}.tmp-${process.pid}`);
  await copyFile(target.bin, tmp);
  await chmod(tmp, 0o755);
  await rename(tmp, out);
  console.log(`installed ${out}`);
}

for (const target of targets) {
  console.log(`\n=== building ${target.name} ===`);
  for (const step of target.build) {
    await run(step);
  }
  await install(target);
}
