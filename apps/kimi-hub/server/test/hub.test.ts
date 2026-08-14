/**
 * Real loopback integration for the hub server:
 *
 * - the hub runs via `startHub` on an ephemeral port with a fixed token and a
 *   throwaway `webDist`;
 * - a fake "agent local server" (`node:http` + `ws` echo) stands in for the
 *   loopback kap-server;
 * - a real `startTunnelClient` connects the two through `/internal/tunnel`.
 *
 * Covers the hub contract: bearer auth (40101), agent roster, REST proxy with
 * body + query passthrough, Authorization hygiene across the tunnel, the WS
 * relay (text + binary, subprotocol auth), the `/hub/api/stream` roster push
 * channel, the 40401 envelope for unknown agents, and token-free static
 * hosting.
 */

import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import Fastify, { type FastifyInstance } from 'fastify';

import { TUNNEL_PATH, TUNNEL_PROTOCOL_VERSION } from '@moonshot-ai/remote-tunnel';
import {
  startTunnelClient,
  type TunnelClientHandle,
  type TunnelClientState,
} from '@moonshot-ai/remote-tunnel/agent';

import { SEA_WEB_MANIFEST_VERSION, seaWebAssetKey } from '../scripts/sea-manifest.mjs';
import { connectBannerLines } from '../src/banner.js';
import { startHub, type RunningHub } from '../src/index.js';
import { openPushModule, type PushLogger, type PushModule } from '../src/push.js';
import {
  createEmbeddedWebAssetStore,
  loadEmbeddedWebAssetManifest,
  parseEmbeddedWebAssetManifest,
  registerWebAssetRoutes,
  type EmbeddedWebAssetManifest,
} from '../src/routes/webAssets.js';

/* web-push makes real network calls; stub it so fanout tests drive the
 * sendNotification outcomes they need and the hub boots never dial out. */
const pushMocks = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock('web-push', () => {
  const api = {
    generateVAPIDKeys: () => ({ publicKey: 'test-vapid-public', privateKey: 'test-vapid-private' }),
    setVapidDetails: () => undefined,
    sendNotification: pushMocks.sendNotification,
  };
  return { ...api, default: api };
});

const HUB_TOKEN = 'hub-test-token';
const LOCAL_TOKEN = 'local-test-token';
const WS_ECHO_PATH = '/api/v1/ws';

/* ------------------------------ fake agent server ------------------------------ */

interface LocalServer {
  httpBase: string;
  /** Server-selected subprotocols of accepted echo sockets. */
  wsProtocolsSeen: string[];
  close(): Promise<void>;
}

async function startFakeAgentServer(): Promise<LocalServer> {
  const wsProtocolsSeen: string[] = [];
  const echoWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  echoWss.on('connection', (ws) => {
    wsProtocolsSeen.push(ws.protocol);
    ws.on('message', (data, isBinary) => {
      ws.send(data, { binary: isBinary });
    });
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/v1/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/v1/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-auth-seen': req.headers.authorization ?? '',
        });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== WS_ECHO_PATH) {
      socket.destroy();
      return;
    }
    echoWss.handleUpgrade(req, socket, head, (ws) => {
      echoWss.emit('connection', ws, req);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    httpBase: `http://127.0.0.1:${port}`,
    wsProtocolsSeen,
    close: () => closeHttpServer(server, echoWss),
  };
}

async function closeHttpServer(server: Server, wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

/* ------------------------- fake scoped agent server ------------------------- */

const SCOPE_IN = 's-scoped';
const SCOPE_OUT = 's-other';

/** `ws` message events deliver a Buffer payload (RawData) regardless of frame kind. */
function wsText(data: unknown): string {
  return (data as Buffer).toString('utf8');
}

interface ScopedLocalServer {
  httpBase: string;
  /** Text frames the agent-local WS received from the browser (in order). */
  receivedWsFrames: string[];
  /** Push an agent → browser frame on the accepted WS connection. */
  pushWsFrame(payload: unknown): void;
  close(): Promise<void>;
}

/** Envelope the way kap-server writes it: `{code, msg, data, request_id}`. */
function fakeEnvelope(data: unknown): unknown {
  return { code: 0, msg: 'success', data, request_id: 'fake-req-id' };
}

/**
 * A loopback server mirroring the real kap-server wire shapes the scope
 * enforcement reads: v1 `GET /api/v1/sessions` → `data: {items, has_more}`,
 * v2 `GET /api/v2/sessions` → `data: {items, has_more, next_page_token}` —
 * one in-scope (`s-scoped`) and one out-of-scope (`s-other`) session each.
 */
async function startScopedAgentServer(): Promise<ScopedLocalServer> {
  const receivedWsFrames: string[] = [];
  const current: { ws?: WebSocket } = {};
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    current.ws = ws;
    ws.on('message', (data) => {
      receivedWsFrames.push(wsText(data));
    });
  });

  const v1Session = (id: string, title: string): Record<string, unknown> => ({
    id,
    workspace_id: 'ws-1',
    cwd: '/tmp/ws-1',
    title,
    last_prompt: null,
    created_at: 1,
    updated_at: 2,
    archived: false,
    busy: false,
  });
  const v2Session = (id: string, title: string): Record<string, unknown> => ({
    id,
    workspace: { id: 'ws-1', cwd: '/tmp/ws-1' },
    meta: {
      title,
      last_prompt: null,
      created_at: 1,
      updated_at: 2,
      archived: false,
      archived_at: null,
    },
    activity: { status: 'idle' },
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (payload: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const envelope = (data: unknown, status = 200): void => {
      json(fakeEnvelope(data), status);
    };

    if (req.method === 'GET' && url.pathname === '/api/v1/healthz') {
      json({ ok: true });
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/api/v1/meta' || url.pathname === '/api/v1/auth')) {
      envelope({ path: url.pathname });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/sessions') {
      // A non-envelope body must pass the hub's list filter unchanged.
      if (url.searchParams.get('raw') === '1') {
        json({ weird: 'not-an-envelope' });
        return;
      }
      envelope({ items: [v1Session(SCOPE_IN, 'in scope'), v1Session(SCOPE_OUT, 'out of scope')], has_more: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v2/sessions') {
      envelope({
        items: [v2Session(SCOPE_IN, 'in scope'), v2Session(SCOPE_OUT, 'out of scope')],
        has_more: true,
        next_page_token: 'tok-1',
      });
      return;
    }
    const sessionMatch = /^\/api\/(?:v1|v2)\/sessions\/([^/]+)/.exec(url.pathname);
    if (req.method === 'GET' && sessionMatch !== null) {
      envelope(v1Session(sessionMatch[1]!, `session ${sessionMatch[1]}`));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/sessions') {
      envelope(v1Session('s-new', 'created'), 201);
      return;
    }
    if (req.method === 'POST' && /^\/api\/v1\/sessions\/([^/:]+):[a-z_]+$/.test(url.pathname)) {
      // kap-server's action-suffix routes: `<sid>:abort`, `<sid>:compact`, …
      envelope({ aborted: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/files') {
      envelope({ id: 'f-x', name: 'pasted.png', media_type: 'image/png', size: 3, created_at: 1 });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/files/f-x') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('PNG');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/config') {
      envelope({ theme: 'dark' });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== WS_ECHO_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    httpBase: `http://127.0.0.1:${port}`,
    receivedWsFrames,
    pushWsFrame: (payload) => current.ws?.send(JSON.stringify(payload)),
    close: () => closeHttpServer(server, wss),
  };
}

/* ---------------------------------- harness ---------------------------------- */

interface HubTestContext {
  hub: RunningHub;
  client: TunnelClientHandle;
  local: LocalServer;
  webDist: string;
  agentId: string;
  wsOrigin: string;
}

async function setupHub(opts?: {
  dangerousBypassAuth?: boolean;
  agentName?: string;
}): Promise<HubTestContext> {
  const webDist = await mkdtemp(join(tmpdir(), 'kimi-hub-web-'));
  await writeFile(join(webDist, 'index.html'), '<!doctype html><title>kimi-hub-test-ui</title>\n');

  const hub = await startHub({
    host: '127.0.0.1',
    port: 0,
    token: HUB_TOKEN,
    webDist,
    logLevel: 'silent',
    env: {},
    dangerousBypassAuth: opts?.dangerousBypassAuth,
  });
  const local = await startFakeAgentServer();
  const client = startTunnelClient({
    hubUrl: hub.origin,
    token: HUB_TOKEN,
    agent: {
      name: opts?.agentName ?? 'hub-test-agent',
      platform: 'test-platform',
      arch: 'test-arch',
      version: '0.0.0-test',
    },
    local: { httpBase: local.httpBase, token: LOCAL_TOKEN },
    reconnect: false,
  });
  try {
    await waitFor(() => client.agentId() !== undefined);
  } catch (error) {
    await client.close();
    await hub.close();
    await local.close();
    await rm(webDist, { recursive: true, force: true });
    throw error;
  }
  return {
    hub,
    client,
    local,
    webDist,
    agentId: client.agentId()!,
    wsOrigin: hub.origin.replace(/^http/, 'ws'),
  };
}

async function teardownHub(ctx: HubTestContext): Promise<void> {
  await ctx.client.close();
  await ctx.hub.close();
  await ctx.local.close();
  await rm(ctx.webDist, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await sleep(10);
  }
}

/* ----------------------------------- tests ----------------------------------- */

describe('kimi-hub-server', () => {
  let ctx: HubTestContext;

  beforeAll(async () => {
    ctx = await setupHub();
  }, 15_000);

  afterAll(async () => {
    await teardownHub(ctx);
  });

  it('(a) rejects /hub/api/agents without a token (401 + 40101 envelope)', async () => {
    const res = await fetch(`${ctx.hub.origin}/hub/api/agents`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: number; data: unknown; request_id: string };
    expect(body.code).toBe(40101);
    expect(body.data).toBeNull();

    const withBadToken = await fetch(`${ctx.hub.origin}/hub/api/agents`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(withBadToken.status).toBe(401);
  });

  it('(b) lists the connected agent with a valid token', async () => {
    const res = await fetch(`${ctx.hub.origin}/hub/api/agents`, {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { agents: Array<Record<string, unknown>> };
    };
    expect(body.code).toBe(0);
    expect(body.data.agents).toHaveLength(1);
    const agent = body.data.agents[0]!;
    expect(agent['agentId']).toBe(ctx.agentId);
    expect(agent['name']).toBe('hub-test-agent');
    expect(agent['platform']).toBe('test-platform');
    expect(agent['arch']).toBe('test-arch');
    expect(agent['version']).toBe('0.0.0-test');
    expect(agent['connectedAt']).toBeGreaterThan(0);
  });

  it('(c) proxies REST through the tunnel, preserving the query string', async () => {
    const res = await fetch(`${ctx.hub.origin}/agents/${ctx.agentId}/api/v1/healthz?probe=1`, {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('(d+e) relays a POST body verbatim and never leaks the hub token upstream', async () => {
    const res = await fetch(`${ctx.hub.origin}/agents/${ctx.agentId}/api/v1/echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${HUB_TOKEN}`, 'content-type': 'text/plain' },
      body: 'hello through the hub',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello through the hub');
    // The hub stripped the browser's Authorization; the connector injected the
    // agent-local token instead.
    expect(res.headers.get('x-auth-seen')).toBe(`Bearer ${LOCAL_TOKEN}`);

    // `/api/v2/*` is wired the same way: the fake server has no such route, so
    // its own 404 ("not found" text) relayed back proves the prefix reach it.
    const v2 = await fetch(`${ctx.hub.origin}/agents/${ctx.agentId}/api/v2/healthz`, {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
    });
    expect(v2.status).toBe(404);
    expect(await v2.text()).toBe('not found');
  });

  it('(g) answers unknown agents with 404 + the 40401 envelope', async () => {
    const res = await fetch(`${ctx.hub.origin}/agents/no-such-agent/api/v1/healthz`, {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(40401);
    expect(body.data).toBeNull();
  });

  it('(h) serves the web UI shell token-free', async () => {
    const res = await fetch(`${ctx.hub.origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('kimi-hub-test-ui');

    // SPA fallback is token-free too; reserved prefixes are not app routes.
    const spa = await fetch(`${ctx.hub.origin}/some/client/route`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('kimi-hub-test-ui');
  });

  it('(f) relays WebSocket traffic (text + binary) via the kimi-hub.bearer subprotocol', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`, [
      `kimi-hub.bearer.${HUB_TOKEN}`,
    ]);
    try {
      await once(ws, 'open');
      expect(ws.protocol).toBe(`kimi-hub.bearer.${HUB_TOKEN}`);

      ws.send('hub ws echo');
      const [textData, textBinary] = (await once(ws, 'message')) as [Buffer, boolean];
      expect(textData.toString('utf8')).toBe('hub ws echo');
      expect(textBinary).toBe(false);

      ws.send(Buffer.from([1, 2, 3]));
      const [binData, binBinary] = (await once(ws, 'message')) as [Buffer, boolean];
      expect(binBinary).toBe(true);
      expect(binData.equals(Buffer.from([1, 2, 3]))).toBe(true);
    } finally {
      ws.close();
      await once(ws, 'close');
    }
    // The agent's local server saw its OWN token subprotocol, never the hub's.
    expect(ctx.local.wsProtocolsSeen).toContain(`kimi-code.bearer.${LOCAL_TOKEN}`);
  });

  it('rejects a browser WS upgrade without a token', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`);
    const [error] = (await once(ws, 'error')) as [Error];
    expect(error.message).toContain('401');
  });

  it('rejects a tunnel upgrade with a wrong token (registry hello reject)', async () => {
    const states: TunnelClientState[] = [];
    const bad = startTunnelClient({
      hubUrl: ctx.hub.origin,
      token: 'wrong-token',
      agent: { name: 'bad-agent' },
      local: { httpBase: 'http://127.0.0.1:9' },
      reconnect: false,
      onState: (state) => states.push(state),
    });
    try {
      await waitFor(() => states.some((state) => state.kind === 'rejected'));
      expect(states.at(-1)).toMatchObject({ kind: 'rejected' });
    } finally {
      await bad.close();
    }
  });
});

/* ------------------------- session-scoped agent ------------------------- */

interface ScopedHubContext {
  hub: RunningHub;
  client: TunnelClientHandle;
  local: ScopedLocalServer;
  webDist: string;
  agentId: string;
  wsOrigin: string;
}

async function setupScopedHub(agent: { name: string; scope?: { sessions: string[] } }): Promise<ScopedHubContext> {
  const webDist = await mkdtemp(join(tmpdir(), 'kimi-hub-web-'));
  await writeFile(join(webDist, 'index.html'), '<!doctype html><title>kimi-hub-test-ui</title>\n');

  const hub = await startHub({
    host: '127.0.0.1',
    port: 0,
    token: HUB_TOKEN,
    webDist,
    logLevel: 'silent',
    env: {},
  });
  const local = await startScopedAgentServer();
  const client = startTunnelClient({
    hubUrl: hub.origin,
    token: HUB_TOKEN,
    agent: { name: agent.name, platform: 'test-platform', arch: 'test-arch', scope: agent.scope },
    local: { httpBase: local.httpBase, token: LOCAL_TOKEN },
    reconnect: false,
  });
  try {
    await waitFor(() => client.agentId() !== undefined);
  } catch (error) {
    await client.close();
    await hub.close();
    await local.close();
    await rm(webDist, { recursive: true, force: true });
    throw error;
  }
  return {
    hub,
    client,
    local,
    webDist,
    agentId: client.agentId()!,
    wsOrigin: hub.origin.replace(/^http/, 'ws'),
  };
}

async function teardownScopedHub(ctx: ScopedHubContext): Promise<void> {
  await ctx.client.close();
  await ctx.hub.close();
  await ctx.local.close();
  await rm(ctx.webDist, { recursive: true, force: true });
}

function scopedFetch(
  ctx: ScopedHubContext,
  path: string,
  init?: { method?: string; body?: string },
): Promise<Response> {
  return fetch(`${ctx.hub.origin}/agents/${ctx.agentId}${path}`, {
    method: init?.method,
    body: init?.body,
    headers: { authorization: `Bearer ${HUB_TOKEN}` },
  });
}

describe('session-scoped agent', () => {
  let ctx: ScopedHubContext;

  beforeAll(async () => {
    ctx = await setupScopedHub({ name: 'scoped-agent', scope: { sessions: [SCOPE_IN] } });
  }, 15_000);

  afterAll(async () => {
    await teardownScopedHub(ctx);
  });

  it('(a) REST allows in-scope session paths and bootstrap GETs', async () => {
    const session = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_IN}`);
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { code: number; data: { id: string } };
    expect(sessionBody.code).toBe(0);
    expect(sessionBody.data.id).toBe(SCOPE_IN);

    // A subpath + another method on the in-scope session is still session traffic.
    const sub = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_IN}/profile`);
    expect(sub.status).toBe(200);

    for (const path of ['/api/v1/healthz', '/api/v1/meta', '/api/v1/auth']) {
      const res = await scopedFetch(ctx, path);
      expect(res.status).toBe(200);
    }
  });

  it('(a) REST denies out-of-scope sessions, host paths, and session create (40302)', async () => {
    const outOfSession = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_OUT}`);
    expect(outOfSession.status).toBe(403);
    const outOfSessionBody = (await outOfSession.json()) as { code: number; msg: string };
    expect(outOfSessionBody.code).toBe(40302);
    expect(outOfSessionBody.msg).toContain('session-scoped agent:');

    const hostPath = await scopedFetch(ctx, '/api/v1/config');
    expect(hostPath.status).toBe(403);
    expect(((await hostPath.json()) as { code: number }).code).toBe(40302);

    const create = await scopedFetch(ctx, '/api/v1/sessions', { method: 'POST', body: '{}' });
    expect(create.status).toBe(403);
    expect(((await create.json()) as { code: number }).code).toBe(40302);
  });

  it('(a) action-suffix routes match the scope on the id segment (<sid>:abort …)', async () => {
    // kap-server mounts `<sid>:action` as ONE path segment — the scope gate
    // must identify the session by the id portion, not the whole segment.
    for (const action of ['abort', 'compact', 'undo', 'fork', 'btw', 'archive', 'restore']) {
      const res = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_IN}:${action}`, { method: 'POST' });
      expect(res.status, action).toBe(200);
    }
    const out = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_OUT}:abort`, { method: 'POST' });
    expect(out.status).toBe(403);
    expect(((await out.json()) as { code: number }).code).toBe(40302);
  });

  it('(files) forwards /api/v1/files — prompt attachments pass the scope gate', async () => {
    const upload = await scopedFetch(ctx, '/api/v1/files', { method: 'POST', body: 'PNG' });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { code: number; data: { id: string } };
    expect(uploaded.code).toBe(0);
    expect(uploaded.data.id).toBe('f-x');

    const download = await scopedFetch(ctx, '/api/v1/files/f-x');
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('PNG');
  });

  it('(a) REST filters the v1 session list to in-scope ids', async () => {
    const res = await scopedFetch(ctx, '/api/v1/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { items: Array<{ id: string; title: string }>; has_more: boolean };
    };
    expect(body.code).toBe(0);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({ id: SCOPE_IN, title: 'in scope' });
    expect(body.data.has_more).toBe(true); // sibling fields pass through
  });

  it('(a) REST filters the v2 session list to in-scope ids', async () => {
    const res = await scopedFetch(ctx, '/api/v2/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { items: Array<{ id: string }>; next_page_token: string | null };
    };
    expect(body.code).toBe(0);
    expect(body.data.items.map((item) => item.id)).toEqual([SCOPE_IN]);
    expect(body.data.next_page_token).toBe('tok-1');
  });

  it('(a) REST passes a non-envelope list response through unchanged', async () => {
    const res = await scopedFetch(ctx, '/api/v1/sessions?raw=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weird: 'not-an-envelope' });
  });

  it('(b) WS rewrites subscribe to the scope ∩ and drops fully out-of-scope ones', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`, [
      `kimi-hub.bearer.${HUB_TOKEN}`,
    ]);
    try {
      await once(ws, 'open');
      const seen = () => ctx.local.receivedWsFrames.map((frame) => JSON.parse(frame) as Record<string, unknown>);

      ws.send(
        JSON.stringify({
          type: 'subscribe',
          id: 'sub-1',
          payload: {
            session_ids: [SCOPE_IN, SCOPE_OUT],
            cursors: { [SCOPE_IN]: { seq: 5 }, [SCOPE_OUT]: { seq: 9 } },
            agent_filter: { [SCOPE_IN]: ['a1'], [SCOPE_OUT]: ['a2'] },
          },
        }),
      );
      // Fully out-of-scope: dropped before the tunnel, the agent never sees it.
      ws.send(JSON.stringify({ type: 'subscribe', id: 'sub-2', payload: { session_ids: [SCOPE_OUT] } }));
      // Sentinel passing frame: proves the pipe stayed alive after the drops.
      ws.send(JSON.stringify({ type: 'pong', payload: { nonce: 'sentinel' } }));
      await waitFor(() => seen().some((frame) => frame['type'] === 'pong'));

      const frames = seen();
      const subscribes = frames.filter((frame) => frame['type'] === 'subscribe');
      expect(subscribes).toHaveLength(1);
      expect(subscribes[0]).toMatchObject({
        type: 'subscribe',
        id: 'sub-1',
        payload: {
          session_ids: [SCOPE_IN],
          cursors: { [SCOPE_IN]: { seq: 5 } },
          agent_filter: { [SCOPE_IN]: ['a1'] },
        },
      });
    } finally {
      ws.close();
      await once(ws, 'close');
    }
  });

  it('(b) WS drops subscribe_v2/unsubscribe_v2 for out-of-scope sessions', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`, [
      `kimi-hub.bearer.${HUB_TOKEN}`,
    ]);
    try {
      await once(ws, 'open');
      ctx.local.receivedWsFrames.length = 0;

      ws.send(JSON.stringify({ type: 'subscribe_v2', id: 'v2-drop', payload: { session_id: SCOPE_OUT, transcript: { grades: ['turn'] } } }));
      ws.send(JSON.stringify({ type: 'unsubscribe_v2', id: 'v2-drop-2', payload: { session_id: SCOPE_OUT } }));
      ws.send(JSON.stringify({ type: 'subscribe_v2', id: 'v2-pass', payload: { session_id: SCOPE_IN, transcript: { grades: ['turn'] } } }));
      await waitFor(() =>
        ctx.local.receivedWsFrames.some((frame) => (JSON.parse(frame) as { id?: string }).id === 'v2-pass'),
      );

      const ids = ctx.local.receivedWsFrames.map((frame) => (JSON.parse(frame) as { id?: string }).id);
      expect(ids).toEqual(['v2-pass']);
    } finally {
      ws.close();
      await once(ws, 'close');
    }
  });

  it('(b) WS drops server frames whose session_id is out of scope', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`, [
      `kimi-hub.bearer.${HUB_TOKEN}`,
    ]);
    const received: unknown[] = [];
    ws.on('message', (data) => received.push(JSON.parse(wsText(data))));
    try {
      await once(ws, 'open');
      // A global event for another session must never reach the browser;
      // the in-scope event + the session-less ping right behind it prove the drop.
      ctx.local.pushWsFrame({ type: 'session_event', session_id: SCOPE_OUT, seq: 1, timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'agent.started' } });
      ctx.local.pushWsFrame({ type: 'session_event', session_id: SCOPE_IN, seq: 2, timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'agent.started' } });
      ctx.local.pushWsFrame({ type: 'ping', timestamp: '2026-01-01T00:00:00.000Z', payload: { nonce: 'hb' } });
      await waitFor(() => received.some((frame) => (frame as { type?: string }).type === 'ping'));

      expect(received).toEqual([
        { type: 'session_event', session_id: SCOPE_IN, seq: 2, timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'agent.started' } },
        { type: 'ping', timestamp: '2026-01-01T00:00:00.000Z', payload: { nonce: 'hb' } },
      ]);
    } finally {
      ws.close();
      await once(ws, 'close');
    }
  });

  it('(scope-follow) updateScope mid-connection widens an already-open browser WS', async () => {
    // The browser socket upgrades while SCOPE_OUT is still out of scope —
    // regression shape for the old upgrade-time snapshot.
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`, [
      `kimi-hub.bearer.${HUB_TOKEN}`,
    ]);
    const received: unknown[] = [];
    ws.on('message', (data) => received.push(JSON.parse(wsText(data))));
    try {
      await once(ws, 'open');
      ctx.local.receivedWsFrames.length = 0;

      ctx.client.updateScope([SCOPE_IN, SCOPE_OUT]);
      // The scope.update frame crosses the tunnel asynchronously; the roster
      // REST surface is the deterministic "hub applied it" sync point.
      const roster = async (): Promise<string[]> => {
        const res = await fetch(`${ctx.hub.origin}/hub/api/agents`, {
          headers: { authorization: `Bearer ${HUB_TOKEN}` },
        });
        const body = (await res.json()) as {
          data: { agents: Array<{ scope?: { sessions: string[] } }> };
        };
        return body.data.agents[0]?.scope?.sessions ?? [];
      };
      let sessions: string[] = [];
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !sessions.includes(SCOPE_OUT)) {
        sessions = await roster();
        await sleep(10);
      }
      expect(sessions).toEqual([SCOPE_IN, SCOPE_OUT]);

      // Client → hub: a subscribe_v2 that would have been dropped pre-update.
      ws.send(JSON.stringify({ type: 'subscribe_v2', id: 'post', payload: { session_id: SCOPE_OUT, transcript: { grades: ['turn'] } } }));
      await waitFor(() =>
        ctx.local.receivedWsFrames.some((frame) => (JSON.parse(frame) as { id?: string }).id === 'post'),
      );
      expect(
        ctx.local.receivedWsFrames.map((frame) => (JSON.parse(frame) as { id?: string }).id),
      ).toEqual(['post']);

      // Hub → browser: a SCOPE_OUT event now passes the same open socket.
      ctx.local.pushWsFrame({ type: 'session_event', session_id: SCOPE_OUT, seq: 10, timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'agent.started' } });
      await waitFor(() => received.length === 1);
      expect(received[0]).toMatchObject({ session_id: SCOPE_OUT });

      // REST follows too: the former 40302 target is now reachable.
      const gated = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_OUT}`);
      expect(gated.status).toBe(200);
    } finally {
      ws.close();
      await once(ws, 'close');
    }
  });
});

describe('unscoped agent (regression)', () => {
  let ctx: ScopedHubContext;

  beforeAll(async () => {
    ctx = await setupScopedHub({ name: 'unscoped-agent' });
  }, 15_000);

  afterAll(async () => {
    await teardownScopedHub(ctx);
  });

  it('(c) reports no scope in /hub/api/agents', async () => {
    const res = await fetch(`${ctx.hub.origin}/hub/api/agents`, {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
    });
    const body = (await res.json()) as { data: { agents: Array<Record<string, unknown>> } };
    expect(body.data.agents).toHaveLength(1);
    expect(body.data.agents[0]!['scope']).toBeUndefined();
  });

  it('(c) proxies every path and every frame unfiltered', async () => {
    // Host paths and out-of-any-scope session ids stay reachable.
    const config = await scopedFetch(ctx, '/api/v1/config');
    expect(config.status).toBe(200);
    const other = await scopedFetch(ctx, `/api/v1/sessions/${SCOPE_OUT}`);
    expect(other.status).toBe(200);

    // The session list is NOT filtered.
    const list = await scopedFetch(ctx, '/api/v1/sessions');
    const listBody = (await list.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items.map((item) => item.id)).toEqual([SCOPE_IN, SCOPE_OUT]);

    // subscribe for any session passes verbatim; out-of-scope events come back.
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`, [
      `kimi-hub.bearer.${HUB_TOKEN}`,
    ]);
    const received: unknown[] = [];
    ws.on('message', (data) => received.push(JSON.parse(wsText(data))));
    try {
      await once(ws, 'open');
      const frame = JSON.stringify({ type: 'subscribe', id: 'sub', payload: { session_ids: [SCOPE_IN, SCOPE_OUT] } });
      ws.send(frame);
      await waitFor(() => ctx.local.receivedWsFrames.includes(frame));

      ctx.local.pushWsFrame({ type: 'session_event', session_id: SCOPE_OUT, seq: 1, timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'agent.started' } });
      await waitFor(() => received.length === 1);
      expect(received[0]).toMatchObject({ session_id: SCOPE_OUT });
    } finally {
      ws.close();
      await once(ws, 'close');
    }
  });
});

/* ------------------------------ hub roster stream ------------------------------ */

interface StreamHubContext {
  hub: RunningHub;
  local: LocalServer;
  webDist: string;
  wsOrigin: string;
}

/** Bare hub (no agent yet) + fake agent server, for the connect/disconnect story. */
async function setupStreamHub(): Promise<StreamHubContext> {
  const webDist = await mkdtemp(join(tmpdir(), 'kimi-hub-web-'));
  await writeFile(join(webDist, 'index.html'), '<!doctype html><title>kimi-hub-test-ui</title>\n');

  const hub = await startHub({
    host: '127.0.0.1',
    port: 0,
    token: HUB_TOKEN,
    webDist,
    logLevel: 'silent',
    env: {},
  });
  let local: LocalServer;
  try {
    local = await startFakeAgentServer();
  } catch (error) {
    await hub.close();
    await rm(webDist, { recursive: true, force: true });
    throw error;
  }
  return {
    hub,
    local,
    webDist,
    wsOrigin: hub.origin.replace(/^http/, 'ws'),
  };
}

/**
 * `WS /hub/api/stream`: envelope-free `{type: 'roster', agents}` snapshots,
 * pushed immediately on connect and again on every roster change. One stream
 * socket is opened in (a) and kept across the ordered steps (b → d).
 */
describe('hub roster stream', () => {
  let ctx: StreamHubContext;
  let stream: WebSocket | undefined;
  let client: TunnelClientHandle | undefined;
  const frames: Array<{ type: string; agents: Array<{ name: string }> }> = [];

  beforeAll(async () => {
    ctx = await setupStreamHub();
  }, 15_000);

  afterAll(async () => {
    stream?.close();
    await client?.close();
    await ctx.hub.close();
    await ctx.local.close();
    await rm(ctx.webDist, { recursive: true, force: true });
  });

  it('(a) pushes an empty roster snapshot immediately on connect', async () => {
    stream = new WebSocket(`${ctx.wsOrigin}/hub/api/stream`, [`kimi-hub.bearer.${HUB_TOKEN}`]);
    stream.on('message', (data) => frames.push(JSON.parse(wsText(data))));
    await once(stream, 'open');
    expect(stream.protocol).toBe(`kimi-hub.bearer.${HUB_TOKEN}`);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.type).toBe('roster');
    expect(frames[0]!.agents).toHaveLength(0);
  });

  it('(b) pushes a new roster frame when a tunnel agent connects', async () => {
    client = startTunnelClient({
      hubUrl: ctx.hub.origin,
      token: HUB_TOKEN,
      agent: { name: 'stream-test-agent', platform: 'test-platform', arch: 'test-arch' },
      local: { httpBase: ctx.local.httpBase, token: LOCAL_TOKEN },
      reconnect: false,
    });
    await waitFor(() => frames.length === 2);
    expect(frames[1]!.type).toBe('roster');
    expect(frames[1]!.agents).toHaveLength(1);
    expect(frames[1]!.agents[0]!.name).toBe('stream-test-agent');
  });

  it('(c) rejects a wrong-token bearer subprotocol (401)', async () => {
    const bad = new WebSocket(`${ctx.wsOrigin}/hub/api/stream`, ['kimi-hub.bearer.wrong-token']);
    const [error] = (await once(bad, 'error')) as [Error];
    expect(error.message).toContain('401');
  });

  it('(notify) fans an agent `notify` frame out to the open stream with the agent identity', async () => {
    client!.notify({
      notificationId: 'ntf-x',
      sessionId: 'ses-9',
      agentId: 'main',
      title: 'needs you',
      body: 'the build failed',
    });
    await waitFor(() => frames.some((f) => f.type === 'notify'));
    const frame = frames.find((f) => f.type === 'notify') as unknown as {
      type: 'notify';
      notificationId: string;
      sessionId: string;
      agentName: string;
      title: string;
      body: string;
      agentId: string;
    };
    expect(frame).toMatchObject({
      type: 'notify',
      notificationId: 'ntf-x',
      sessionId: 'ses-9',
      agentName: 'stream-test-agent',
      title: 'needs you',
      body: 'the build failed',
    });
    expect(typeof frame.agentId).toBe('string');
  });

  it('(d) pushes an empty roster frame when the agent disconnects', async () => {
    const rosterBefore = frames.filter((f) => f.type === 'roster').length;
    await client!.close();
    client = undefined;
    await waitFor(() => frames.filter((f) => f.type === 'roster').length === rosterBefore + 1);
    expect(frames.at(-1)!.type).toBe('roster');
    expect(frames.at(-1)!.agents).toHaveLength(0);
  });
});

/* ------------------------- --dangerous-bypass-auth ------------------------- */

/**
 * The bypass hub runs with `disableAuth: true`: every HTTP/WS surface skips
 * its credential check, and `startHub` creates the registry with
 * `trustAnyToken: true` — the `TUNNEL_PATH` handshake no longer validates the
 * token either (subprotocol OR `hello.token`), so agents can connect
 * tokenless. Handshakes presenting the banner token still register.
 */
describe('hub with bypass on (--dangerous-bypass-auth)', () => {
  let ctx: HubTestContext;

  beforeAll(async () => {
    ctx = await setupHub({ dangerousBypassAuth: true, agentName: 'bypass-test-agent' });
  }, 15_000);

  afterAll(async () => {
    await teardownHub(ctx);
  });

  it('reports dangerousBypassAuth and warns exactly once', () => {
    expect(ctx.hub.dangerousBypassAuth).toBe(true);
    expect(ctx.hub.warnings).toEqual([expect.stringContaining('auth DISABLED')]);
  });

  it('(a) serves GET /hub/api/agents with NO Authorization', async () => {
    const res = await fetch(`${ctx.hub.origin}/hub/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: number;
      data: { agents: Array<{ agentId: string; name: string }> };
    };
    expect(body.code).toBe(0);
    expect(body.data.agents).toHaveLength(1);
  });

  it('(b) accepts the roster-stream upgrade with NO subprotocol and pushes a roster frame', async () => {
    const stream = new WebSocket(`${ctx.wsOrigin}/hub/api/stream`);
    const frames: Array<{ type: string; agents: Array<{ name: string }> }> = [];
    stream.on('message', (data) => frames.push(JSON.parse(wsText(data))));
    try {
      await once(stream, 'open');
      expect(stream.protocol).toBe('');
      await waitFor(() => frames.length > 0);
      expect(frames[0]!.type).toBe('roster');
      expect(frames[0]!.agents.map((agent) => agent.name)).toEqual(['bypass-test-agent']);
    } finally {
      stream.close();
      await once(stream, 'close');
    }
  });

  it('(c) accepts the agents-relay upgrade with NO auth', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}/agents/${ctx.agentId}/api/v1/ws`);
    try {
      await once(ws, 'open');
      expect(ws.protocol).toBe('');
      ws.send('bypass echo');
      const [data, binary] = (await once(ws, 'message')) as [Buffer, boolean];
      expect(binary).toBe(false);
      expect(data.toString('utf8')).toBe('bypass echo');
    } finally {
      ws.close();
      await once(ws, 'close');
    }
  });

  it('(d) registers the normal connector path (startTunnelClient with the banner token)', async () => {
    // The setup's connector dialed in through the bypassed hub exactly like a
    // production agent (banner token at the hello): the registry accepted it.
    expect(ctx.client.agentId()).toBe(ctx.agentId);
    const res = await fetch(`${ctx.hub.origin}/hub/api/agents`);
    const body = (await res.json()) as {
      data: { agents: Array<{ agentId: string; name: string }> };
    };
    expect(body.data.agents).toEqual([
      expect.objectContaining({ agentId: ctx.agentId, name: 'bypass-test-agent' }),
    ]);
  });

  it('(e) still rejects a bad-Host roster-stream upgrade (the allowlist is NEVER bypassed)', async () => {
    const stream = new WebSocket(`${ctx.wsOrigin}/hub/api/stream`, {
      headers: { host: 'evil.example.com' },
    });
    const [error] = (await once(stream, 'error')) as [Error];
    expect(error.message).toContain('403');
  });

  it('(f) registers a tunnel agent carrying a WRONG token (registry trustAnyToken)', async () => {
    const wrong = startTunnelClient({
      hubUrl: ctx.hub.origin,
      token: 'wrong-token',
      agent: { name: 'bypass-wrong-token-agent' },
      local: { httpBase: ctx.local.httpBase, token: LOCAL_TOKEN },
      reconnect: false,
    });
    try {
      await waitFor(() => wrong.agentId() !== undefined);
      const res = await fetch(`${ctx.hub.origin}/hub/api/agents`);
      const body = (await res.json()) as {
        data: { agents: Array<{ agentId: string; name: string }> };
      };
      expect(body.data.agents).toContainEqual(
        expect.objectContaining({ agentId: wrong.agentId(), name: 'bypass-wrong-token-agent' }),
      );
    } finally {
      await wrong.close();
    }
  });

  it('(g) registers a raw handshake with NO subprotocol whose hello carries the banner token', async () => {
    const ws = new WebSocket(`${ctx.wsOrigin}${TUNNEL_PATH}`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => frames.push(JSON.parse(wsText(data))));
    try {
      await once(ws, 'open');
      expect(ws.protocol).toBe(''); // no bearer subprotocol offered at all
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: TUNNEL_PROTOCOL_VERSION,
          token: HUB_TOKEN,
          agent: { name: 'bypass-no-subprotocol-agent', platform: 'test-platform', arch: 'test-arch' },
        }),
      );
      await waitFor(() => frames.some((frame) => frame['type'] === 'hello.ack'));
      const res = await fetch(`${ctx.hub.origin}/hub/api/agents`);
      const body = (await res.json()) as {
        data: { agents: Array<{ name: string }> };
      };
      expect(body.data.agents.map((agent) => agent.name)).toContain('bypass-no-subprotocol-agent');
    } finally {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await once(ws, 'close');
      }
    }
  });
});

/* ------------------------------ startup banner ------------------------------ */

describe('connectBannerLines', () => {
  it('carries the --token segment between origin and --session when a token is given', () => {
    expect(connectBannerLines({ origin: 'http://hub.example.test:58630', token: 'tok123' })).toEqual([
      'Connect a terminal:',
      '  /remote connect http://hub.example.test:58630 --token tok123 --session <session-id>',
      '…or from the CLI:',
      '  kimi remote connect http://hub.example.test:58630 --token tok123 --session <session-id>',
    ]);
  });

  it('omits the --token segment entirely in bypass mode (tokenless connect)', () => {
    expect(connectBannerLines({ origin: 'http://hub.example.test:58630' })).toEqual([
      'Connect a terminal:',
      '  /remote connect http://hub.example.test:58630 --session <session-id>',
      '…or from the CLI:',
      '  kimi remote connect http://hub.example.test:58630 --session <session-id>',
    ]);
  });
});

/* --------------------------- embedded web assets --------------------------- */

/**
 * The SEA-binary asset source (`createEmbeddedWebAssetStore`) driven by a fake
 * `node:sea`-shaped reader — same HTTP surface as the filesystem `webDist`
 * mode: static hits, SPA fallback, reserved prefixes, the 501 fallback.
 */
describe('embedded web assets (SEA store)', () => {
  const INDEX_HTML = '<!doctype html><title>kimi-hub-embedded-ui</title>\n';
  const INDEX_JS = 'console.log("hub-ui");\n';
  const DOCS_INDEX = '<!doctype html><title>docs</title>\n';

  const assetBytes: Record<string, string> = {
    [seaWebAssetKey('index.html')]: INDEX_HTML,
    [seaWebAssetKey('assets/index.js')]: INDEX_JS,
    [seaWebAssetKey('docs/index.html')]: DOCS_INDEX,
  };
  const manifest: EmbeddedWebAssetManifest = {
    version: SEA_WEB_MANIFEST_VERSION,
    files: ['index.html', 'assets/index.js', 'docs/index.html'],
  };
  /** Mimics `sea.getRawAsset`: throws on unknown keys like the real API. */
  const rawAsset = (key: string): ArrayBuffer => {
    const text = assetBytes[key];
    if (text === undefined) throw new Error(`unable to get embedded asset: ${key}`);
    const buffer = Buffer.from(text, 'utf8');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  };

  let app: FastifyInstance;
  let origin: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerWebAssetRoutes(app, createEmbeddedWebAssetStore(manifest, rawAsset));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no bound address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('(a) serves index.html at / with html mime + Content-Length', async () => {
    const res = await fetch(`${origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('(b) serves a nested asset with js mime', async () => {
    const res = await fetch(`${origin}/assets/index.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe(INDEX_JS);
  });

  it('(c) SPA-falls back to index.html for extension-less paths, dirs included', async () => {
    const spa = await fetch(`${origin}/some/client/route`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-type')).toContain('text/html');
    expect(await spa.text()).toBe(INDEX_HTML);

    // A real dir hit serves its own index.html, not the app shell.
    const docs = await fetch(`${origin}/docs/`);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toBe(DOCS_INDEX);
  });

  it('(d) 404s missing files that carry an extension', async () => {
    const res = await fetch(`${origin}/missing.js`);
    expect(res.status).toBe(404);
  });

  it('(e) keeps reserved prefixes on the 40401 envelope', async () => {
    const res = await fetch(`${origin}/hub/typo`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(40401);
  });

  it('(f) clamps traversal to the embedded root (no escape, no asset read)', async () => {
    // Fully encoded: no literal dots in the raw path → no extension → the
    // decoded ../../etc/passwd clamps to the root and SPA-serves the shell.
    const res = await fetch(`${origin}/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    // The literal-dot spelling has an extension per the raw-path rule (same as
    // the filesystem mode) and therefore 404s instead of falling back.
    const dotted = await fetch(`${origin}/..%2F..%2Fetc%2Fpasswd`);
    expect(dotted.status).toBe(404);
  });

  it('(g) without index.html the routes fall back to 501 text', async () => {
    const bare = Fastify({ logger: false });
    const noIndexManifest: EmbeddedWebAssetManifest = { version: SEA_WEB_MANIFEST_VERSION, files: ['assets/index.js'] };
    await registerWebAssetRoutes(bare, createEmbeddedWebAssetStore(noIndexManifest, rawAsset));
    await bare.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = bare.server.address();
      if (typeof address !== 'object' || address === null) throw new Error('no bound address');
      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(res.status).toBe(501);
      expect(await res.text()).toContain('no index.html under the embedded SEA blob');
    } finally {
      await bare.close();
    }
  });

  it('(h) rejects manifests with an unsupported version', () => {
    const buffer = Buffer.from(JSON.stringify({ version: 999, files: [] }), 'utf8');
    const raw = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    expect(() => parseEmbeddedWebAssetManifest(raw)).toThrow(`version: 999`);
  });

  it('(i) loadEmbeddedWebAssetManifest is null outside a SEA (vitest is not one)', () => {
    expect(loadEmbeddedWebAssetManifest()).toBeNull();
  });
});

/* --------------------------- web push fanout --------------------------- */

/**
 * `openPushModule` failure handling: a permanently dead subscription (browser
 * revoked → 404/410; retired VAPID binding → 400 VapidPkHashMismatch) is
 * pruned from memory AND the persisted file, every failure is logged through
 * the injected logger, and a dead endpoint never blocks the healthy ones.
 */
describe('web push fanout failure handling', () => {
  interface PushWarning {
    obj: {
      endpointHost?: string;
      statusCode?: number;
      reason?: string;
      pruned?: boolean;
    };
    msg?: string;
  }

  let dataDir: string;
  let warnings: PushWarning[];
  let push: PushModule;

  const fakeSubscription = (endpoint: string): Parameters<PushModule['upsert']>[0] =>
    ({ endpoint, keys: { p256dh: 'cDMyZA', auth: 'YXV0aA' } }) as never as Parameters<PushModule['upsert']>[0];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kimi-hub-push-'));
    warnings = [];
    const logger: PushLogger = {
      warn: (obj, msg) => {
        warnings.push({ obj: obj as PushWarning['obj'], msg });
      },
    };
    push = await openPushModule(dataDir, logger);
  });

  afterAll(async () => {
    pushMocks.sendNotification.mockReset();
    await push.flush(); // drain queued best-effort writes before removing the dir
    await rm(dataDir, { recursive: true, force: true });
  });

  it('prunes a 400 VapidPkHashMismatch subscription, logs it, and still serves the healthy one', async () => {
    const DEAD = 'https://web.push.apple.com/dead-endpoint';
    const HEALTHY = 'https://web.push.apple.com/healthy-endpoint';
    pushMocks.sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === DEAD) {
        const error = new Error('Received unexpected response code') as Error & { statusCode: number; body: string };
        error.statusCode = 400;
        error.body = '{"reason":"VapidPkHashMismatch"}';
        throw error;
      }
      return { statusCode: 201, headers: {}, body: '' };
    });
    push.upsert(fakeSubscription(DEAD));
    push.upsert(fakeSubscription(HEALTHY));
    const sent = await push.fanout({ notificationId: 'n1', sessionId: 's1', title: 't', body: 'b', agentName: 'a' });
    expect(sent).toBe(1);
    expect(push.list().map((s) => s.endpoint)).toEqual([HEALTHY]);
    // Persist is fire-and-forget (serialized internally): poll until the file catches up.
    const persistedPath = join(dataDir, 'push-subscriptions.json');
    await waitFor(() => {
      try {
        const persisted = JSON.parse(readFileSync(persistedPath, 'utf8')) as Array<{ endpoint: string }>;
        return persisted.length === 1 && persisted[0]!.endpoint === HEALTHY;
      } catch {
        return false; // first persist (tmp + rename) hasn't landed yet
      }
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.obj).toMatchObject({
      endpointHost: 'web.push.apple.com',
      statusCode: 400,
      reason: 'VapidPkHashMismatch',
      pruned: true,
    });
  });

  it('logs but keeps the subscription on a transient failure (503, no reason)', async () => {
    const FLAKY = 'https://fcm.googleapis.com/fcm/send/flaky';
    pushMocks.sendNotification.mockRejectedValue(Object.assign(new Error('Received unexpected response code'), { statusCode: 503 }));
    push.upsert(fakeSubscription(FLAKY));
    const sent = await push.fanout({ notificationId: 'n2', sessionId: 's1', title: 't', body: 'b', agentName: 'a' });
    expect(sent).toBe(0);
    expect(push.list().map((s) => s.endpoint)).toContain(FLAKY);
    expect(warnings.at(-1)!.obj).toMatchObject({ endpointHost: 'fcm.googleapis.com', statusCode: 503, pruned: false });
    expect(warnings.at(-1)!.obj.reason).toBeUndefined();
    push.remove(FLAKY);
  });
});
