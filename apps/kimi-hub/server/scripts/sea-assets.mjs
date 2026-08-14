/**
 * Collect the built hub web UI (`apps/kimi-hub/web/dist`) into the SEA asset
 * map: one asset `web/dist/<posix path relative to the dist root>` per file,
 * plus the manifest stored as `web/assets-manifest.json` listing those
 * relative paths (the runtime lookup table — see `src/routes/webAssets.ts`).
 *
 * Slimmed-down port of apps/kimi-code `scripts/native/web-assets.mjs`.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { SEA_WEB_MANIFEST_VERSION, seaWebAssetKey } from './sea-manifest.mjs';

function toPosixPath(path) {
  return path.split('\\').join('/');
}

async function listFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}

/**
 * @returns `{ manifestJson, assets, fileCount }` — `assets` maps SEA asset
 * keys to absolute file paths (goes straight into the sea-config `assets`
 * dict); `manifestJson` lands as the `web/assets-manifest.json` asset itself.
 */
export async function collectSeaWebAssets({ webDistDir }) {
  const root = resolve(webDistDir);
  try {
    const info = await stat(join(root, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Hub web build output was not found at ${root}. Run \`pnpm --filter @moonshot-ai/kimi-hub-web run build\` before building the native executable.`,
    );
  }

  const assets = {};
  const filePaths = [];
  for (const file of (await listFiles(root)).toSorted((a, b) => a.localeCompare(b))) {
    const relativePath = toPosixPath(relative(root, file));
    filePaths.push(relativePath);
    assets[seaWebAssetKey(relativePath)] = file;
  }

  const manifest = {
    version: SEA_WEB_MANIFEST_VERSION,
    files: filePaths,
  };
  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    assets,
    fileCount: filePaths.length,
  };
}
