/**
 * Static hosting of the built hub web UI (`apps/kimi-hub/web/dist`) with SPA
 * fallback — trimmed port of kap-server's `routes/webAssets.ts`.
 *
 * Registered LAST: the `/*` fallback only catches paths not claimed by
 * `/hub/api/...` or the `/agents/...` proxy. Reserved prefixes
 * (`/hub` / `/agents` / `/internal`) are never served from the bundle — they
 * answer with the `40401` envelope instead.
 *
 * Unlike kap-server a missing bundle is tolerated (the server is still useful
 * for tunnel termination): `/` then answers `501` text instead of boot failing.
 *
 * Two asset sources share the internal `WebAssetStore` below:
 * - filesystem over `webDist`: the dev default; also forced whenever
 *   `--web-dist` is passed explicitly (even inside a SEA binary);
 * - embedded in a SEA binary (`node:sea`): the native build
 *   (`scripts/build-native.mjs`) injects every `web/dist` file as asset
 *   `web/dist/<posix path>` plus the manifest `web/assets-manifest.json`
 *   written by `scripts/sea-assets.mjs`, so the binary serves the UI with no
 *   repo layout required.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { getRawAsset, isSea } from 'node:sea';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isReservedPath } from '#/auth';
import { errEnvelope, HUB_ERROR_CODES } from '#/envelope';
import {
  SEA_WEB_MANIFEST_KEY,
  SEA_WEB_MANIFEST_VERSION,
  seaWebAssetKey,
} from '../../scripts/sea-manifest.mjs';

/** One static-file hit (or SPA fallback) ready to send. */
export interface WebAssetFile {
  readonly mimeType: string;
  readonly size: number;
  /** Fastify reply payload: streamed from disk or held in memory. */
  readonly body: Buffer | NodeJS.ReadableStream;
}

export interface WebAssetStore {
  /** Where assets come from, used by the 501 fallback message. */
  readonly source: string;
  /** Whether the source has an `index.html`; without it the 501 fallback is registered. */
  hasIndexHtml(): Promise<boolean>;
  /** Static hit or SPA fallback for a request pathname; `undefined` → 404. */
  resolve(pathname: string): Promise<WebAssetFile | undefined>;
}

export interface WebAssetStoreOptions {
  readonly webDist: string;
  /** Explicit `--web-dist`: keep filesystem serving even in a SEA binary. */
  readonly webDistFromCli?: boolean;
}

export async function registerWebAssetRoutes(
  app: FastifyInstance,
  store: WebAssetStore,
): Promise<void> {
  const available = await store.hasIndexHtml();
  if (!available) {
    const missing = async (req: FastifyRequest, reply: FastifyReply) => {
      if (isReservedPath(requestPath(req))) {
        return reply.code(404).send(errEnvelope(HUB_ERROR_CODES.notFound, 'not found', req.id));
      }
      return reply
        .code(501)
        .type('text/plain; charset=utf-8')
        .send(`kimi-hub web UI is not available (no index.html under ${store.source})`);
    };
    app.get('/', missing);
    app.get('/*', missing);
    return;
  }

  const serve = async (req: FastifyRequest, reply: FastifyReply) =>
    serveWebAsset(req, reply, store);
  app.get('/', serve);
  app.get('/*', serve);
}

/**
 * Pick the asset source: an explicit `--web-dist` dir always wins; a SEA
 * binary otherwise serves its embedded bundle when the blob carries one;
 * everything else (dev, `node dist/main.mjs`) serves the FS dist dir.
 */
export function createWebAssetStore(options: WebAssetStoreOptions): WebAssetStore {
  if (!options.webDistFromCli) {
    const manifest = loadEmbeddedWebAssetManifest();
    if (manifest !== null) {
      return createEmbeddedWebAssetStore(manifest);
    }
  }
  return createFsWebAssetStore(options.webDist);
}

async function serveWebAsset(
  req: FastifyRequest,
  reply: FastifyReply,
  store: WebAssetStore,
): Promise<unknown> {
  const { pathname } = new URL(req.raw.url ?? '/', 'http://kimi-hub.local');
  if (isReservedPath(pathname)) {
    return reply.code(404).send(errEnvelope(HUB_ERROR_CODES.notFound, 'not found', req.id));
  }

  const file = await store.resolve(pathname);
  if (file === undefined) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }

  return reply.type(file.mimeType).header('Content-Length', String(file.size)).send(file.body);
}

function requestPath(req: FastifyRequest): string {
  const raw = req.raw.url ?? '/';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.webmanifest':
      return 'application/manifest+json';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

/* ------------------------------ filesystem mode ------------------------------ */

function createFsWebAssetStore(assetsDir: string): WebAssetStore {
  return {
    source: assetsDir,
    hasIndexHtml: async () => {
      const info = await stat(join(assetsDir, 'index.html')).catch(() => undefined);
      return info?.isFile() === true;
    },
    resolve: async (pathname) => {
      const filePath = await resolveStaticFile(assetsDir, pathname);
      const fileInfo =
        filePath === undefined ? undefined : await stat(filePath).catch(() => undefined);
      if (filePath === undefined || fileInfo === undefined || !fileInfo.isFile()) {
        return undefined;
      }
      return {
        mimeType: mimeType(filePath),
        size: fileInfo.size,
        body: createReadStream(filePath),
      };
    },
  };
}

async function resolveStaticFile(
  assetsDir: string,
  pathname: string,
): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const normalized = normalize(decoded).replace(/^(\.\.(?:[/\\]|$))+/, '');
  const relative = normalized === sep ? 'index.html' : normalized.replace(/^[/\\]/, '');
  const root = resolve(assetsDir);
  const candidate = resolve(
    root,
    relative.endsWith(sep) ? join(relative, 'index.html') : relative,
  );
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  const info = await stat(candidate).catch(() => undefined);
  if (info?.isFile() === true) {
    return candidate;
  }
  if (extname(pathname) !== '') {
    return undefined;
  }
  // SPA fallback: unknown extension-less paths load the app shell.
  return join(root, 'index.html');
}

/* ------------------------------- embedded mode ------------------------------- */

/** Parsed `web/assets-manifest.json`; keys are posix paths relative to the dist root. */
export interface EmbeddedWebAssetManifest {
  readonly version: typeof SEA_WEB_MANIFEST_VERSION;
  readonly files: readonly string[];
}

/**
 * The embedded web manifest when running as a SEA binary whose blob carries
 * one; `null` everywhere else (dev, tests, plain `node dist/main.mjs`).
 * Injectable raw-asset reader so tests can drive this without a real SEA.
 */
export function loadEmbeddedWebAssetManifest(
  rawAsset: (key: string) => ArrayBuffer = getRawAsset,
): EmbeddedWebAssetManifest | null {
  if (!isSea()) {
    return null;
  }
  let raw: ArrayBuffer;
  try {
    raw = rawAsset(SEA_WEB_MANIFEST_KEY);
  } catch {
    // A SEA without embedded web assets: tolerate like a missing FS bundle
    // (the routes then fall back to `webDist`, usually answering 501).
    return null;
  }
  return parseEmbeddedWebAssetManifest(raw);
}

/** Parse + validate embedded manifest bytes (exported for tests). */
export function parseEmbeddedWebAssetManifest(raw: ArrayBuffer): EmbeddedWebAssetManifest {
  const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid embedded web assets manifest: not an object');
  }
  const { version, files } = parsed as { version?: unknown; files?: unknown };
  if (version !== SEA_WEB_MANIFEST_VERSION) {
    throw new Error(`Unsupported embedded web assets manifest version: ${String(version)}`);
  }
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    throw new Error('Invalid embedded web assets manifest: files must be a string array');
  }
  return { version: SEA_WEB_MANIFEST_VERSION, files: files as string[] };
}

export function createEmbeddedWebAssetStore(
  manifest: EmbeddedWebAssetManifest,
  rawAsset: (key: string) => ArrayBuffer = getRawAsset,
): WebAssetStore {
  const files = new Set(manifest.files);
  const read = (relativePath: string): Buffer | undefined => {
    if (!files.has(relativePath)) {
      return undefined;
    }
    try {
      return Buffer.from(rawAsset(seaWebAssetKey(relativePath)));
    } catch {
      return undefined;
    }
  };
  return {
    source: 'the embedded SEA blob',
    hasIndexHtml: async () => files.has('index.html'),
    resolve: async (pathname) => {
      let relativePath = normalizeEmbeddedPath(pathname);
      if (relativePath === undefined) {
        return undefined;
      }
      if (relativePath === '') {
        relativePath = 'index.html';
      } else if (relativePath.endsWith('/')) {
        relativePath = `${relativePath}index.html`;
      }
      let body = read(relativePath);
      if (body === undefined && extname(pathname) === '') {
        // SPA fallback: unknown extension-less paths load the app shell.
        relativePath = 'index.html';
        body = read(relativePath);
      }
      if (body === undefined) {
        return undefined;
      }
      return { mimeType: mimeType(relativePath), size: body.length, body };
    },
  };
}

/**
 * Map a request pathname to a posix path relative to the dist root — the
 * embedded-store sibling of `resolveStaticFile`'s normalization: url-decode,
 * split on `/`, collapse `.` and `..` (clamped at the root; keys never
 * contain backslashes).
 */
function normalizeEmbeddedPath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const segments: string[] = [];
  const endsWithSlash = decoded.endsWith('/');
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join('/');
  return endsWithSlash && joined !== '' ? `${joined}/` : joined;
}
