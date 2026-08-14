/**
 * Build the self-contained SEA executable of the hub server:
 *
 *   main.cjs (tsdown, all deps bundled) + embedded `web/dist` assets
 *     → node --experimental-sea-config → postject inject into a node copy
 *     → dist-native/bin/<platform-triple>/kimi-hub
 *
 * Slimmed-down port of apps/kimi-code `scripts/native/` (its 01-bundle →
 * 02-sea-blob → 03-inject chain folded into one file). `--smoke` additionally
 * boots the binary from a non-repo cwd and exercises auth + static hosting.
 */

/* oxlint-disable no-console -- a build script: stdout IS its UI */

import { execFile, spawn } from 'node:child_process';
import { copyFile, chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { collectSeaWebAssets } from './sea-assets.mjs';
import { SEA_WEB_MANIFEST_KEY } from './sea-manifest.mjs';

const execFileAsync = promisify(execFile);

/* ---------------------------------- paths ---------------------------------- */

const serverRoot = resolve(import.meta.dirname, '..');
const webDistDir = resolve(serverRoot, '..', 'web', 'dist');
const intermediatesDir = resolve(serverRoot, 'dist-native', 'intermediates');

const jsBundlePath = resolve(intermediatesDir, 'main.cjs');
const blobPath = resolve(intermediatesDir, 'kimi-hub.blob');
const seaConfigPath = resolve(intermediatesDir, 'sea-config.json');
const webManifestPath = resolve(intermediatesDir, 'web-assets-manifest.json');

const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function targetTriple() {
  return process.env.KIMI_HUB_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
}

function binPath(target = targetTriple()) {
  const name = process.platform === 'win32' ? 'kimi-hub.exe' : 'kimi-hub';
  return resolve(serverRoot, 'dist-native', 'bin', target, name);
}

function postjectPath() {
  const command = process.platform === 'win32' ? 'postject.cmd' : 'postject';
  return resolve(serverRoot, 'node_modules/.bin', command);
}

/* ---------------------------------- exec ----------------------------------- */

function fail(message) {
  console.error(message);
  process.exit(1);
}

// .bat/.cmd shims (postject on win32) need cmd.exe; collapses away elsewhere.
function commandForExecFile(command, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(command)) {
    return { command, args };
  }
  const shellCommand = [command, ...args]
    .map((arg) => `"${String(arg).replaceAll('"', '""')}"`)
    .join(' ');
  return {
    command: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { windowsVerbatimArguments: true },
  };
}

async function run(command, args) {
  const exec = commandForExecFile(command, args);
  try {
    const { stdout, stderr } = await execFileAsync(exec.command, exec.args, {
      cwd: serverRoot,
      maxBuffer: 1024 * 1024 * 16,
      ...exec.options,
    });
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  } catch (error) {
    const details = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    fail(`Command failed: ${command} ${args.join(' ')}\n${details}`);
  }
}

async function tryRun(command, args) {
  const exec = commandForExecFile(command, args);
  try {
    await execFileAsync(exec.command, exec.args, {
      cwd: serverRoot,
      maxBuffer: 1024 * 1024 * 16,
      ...exec.options,
    });
  } catch (error) {
    const details = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    console.warn(`Warning: ${command} ${args.join(' ')} failed.\n${details}`);
  }
}

/* ---------------------------------- steps ---------------------------------- */

async function bundleStep() {
  console.log('==> Bundling main.cjs (tsdown, all deps bundled)');
  const tsdownCliPath = createRequire(import.meta.url).resolve('tsdown/run');
  await run(process.execPath, [tsdownCliPath, '--config', 'tsdown.dist-native.config.ts']);
  try {
    await stat(jsBundlePath);
  } catch {
    fail(`Native JS bundle not found at ${jsBundlePath} after tsdown.`);
  }
}

async function seaBlobStep() {
  console.log('==> Writing SEA config and generating the blob');
  const web = await collectSeaWebAssets({ webDistDir });
  await mkdir(intermediatesDir, { recursive: true });
  await writeFile(webManifestPath, web.manifestJson);

  const config = {
    main: jsBundlePath,
    output: blobPath,
    assets: Object.fromEntries(
      Object.entries({
        [SEA_WEB_MANIFEST_KEY]: webManifestPath,
        ...web.assets,
      }).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  };
  await writeFile(seaConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  await run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
  console.log(`Collected embedded web assets: ${web.fileCount} files`);
}

async function injectStep() {
  const target = targetTriple();
  try {
    await stat(blobPath);
  } catch {
    fail(`SEA blob not found at ${blobPath}.`);
  }

  const out = binPath(target);
  await mkdir(dirname(out), { recursive: true });
  try {
    await copyFile(process.execPath, out);
  } catch (error) {
    if (error?.code === 'ETXTBSY') {
      fail(`Cannot overwrite ${out}: ETXTBSY — a kimi-hub process is still running from it; stop it first.`);
    }
    throw error;
  }
  if (process.platform !== 'win32') {
    await chmod(out, 0o755);
  }
  // Strip signatures that would invalidate after injection (no-ops on hosts
  // without the tooling — linux needs neither).
  if (process.platform === 'darwin') {
    await tryRun('codesign', ['--remove-signature', out]);
  }
  if (process.platform === 'win32') {
    await tryRun('signtool', ['remove', '/s', out]);
  }

  const args = [out, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_SENTINEL_FUSE];
  if (process.platform === 'darwin') {
    args.push('--macho-segment-name', 'NODE_SEA');
  }
  await run(postjectPath(), args);
  console.log(`==> Native executable: ${out}`);
}

/* ---------------------------------- smoke ---------------------------------- */

async function smokeStep() {
  const executable = binPath();
  const token = 'smoke-token';
  console.log(`==> Smoke: ${executable} --port 0 --token ${token}`);
  // Boot from outside the repo: the binary must be layout-independent.
  const child = spawn(executable, ['--port', '0', '--token', token, '--log-level', 'silent'], {
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const origin = await new Promise(
    /**
     * @param {(value: string) => void} resolvePromise
     * @param {(reason: Error) => void} reject
     */
    (resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for the startup banner:\n${output}`));
    }, 30_000);
    child.stdout.on('data', () => {
      const originMatch = /Origin: (http:\/\/\S+)/.exec(output)?.[1];
      if (originMatch !== undefined) {
        clearTimeout(timer);
        resolvePromise(originMatch);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`kimi-hub exited before the banner (code ${String(code)}):\n${output}`));
    });
    },
  );

  try {
    const indexRes = await fetch(`${origin}/`);
    const indexBody = await indexRes.text();
    if (indexRes.status !== 200 || !indexBody.includes('<title>Kimi Hub</title>')) {
      fail(`smoke: GET / expected 200 + the hub index.html, got ${indexRes.status}`);
    }
    const unauthRes = await fetch(`${origin}/hub/api/agents`);
    if (unauthRes.status !== 401) {
      fail(`smoke: GET /hub/api/agents without a token expected 401, got ${unauthRes.status}`);
    }
    const authRes = await fetch(`${origin}/hub/api/agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const authBody = await authRes.json();
    if (authRes.status !== 200 || !Array.isArray(authBody?.data?.agents)) {
      fail(`smoke: authed GET /hub/api/agents expected a 200 envelope, got ${authRes.status}`);
    }
    console.log('==> Smoke passed: index.html from the embedded blob, auth gate, roster envelope');
  } finally {
    child.kill('SIGINT');
    const exitCode = await new Promise((resolvePromise) => {
      child.once('exit', (code) => {
        resolvePromise(code);
      });
      setTimeout(() => {
        resolvePromise('timeout');
      }, 10_000).unref();
    });
    if (exitCode !== 0) {
      fail(`smoke: expected clean SIGINT shutdown (exit 0), got ${String(exitCode)}`);
    }
  }
}

/* ------------------------------ orchestration ------------------------------ */

const { values } = parseArgs({
  options: {
    smoke: { type: 'boolean', default: false },
  },
});

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 15)) {
  fail(`kimi-hub native SEA build requires Node.js >=24.15.0, current ${process.versions.node}.`);
}

console.log(`==> Native build (target=${targetTriple()})`);
await bundleStep();
await seaBlobStep();
await injectStep();
if (values.smoke) {
  await smokeStep();
}
console.log('==> Native build complete');
