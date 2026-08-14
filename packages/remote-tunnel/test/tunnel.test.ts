/**
 * End-to-end tunnel tests over real loopback sockets:
 *
 * - `startHub` mirrors the kap-server upgrade pattern (`WebSocketServer` in
 *   `noServer` mode + `http` upgrade dispatch) and hands agent sockets to a
 *   real `createTunnelRegistry`.
 * - `startLocal` fakes the agent's loopback kap-server: a couple of REST
 *   routes (one of them slow, for abort/disconnect tests) and a WS echo
 *   endpoint at `/api/v1/ws`.
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';

import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { startTunnelClient, type TunnelClientHandle, type TunnelClientState } from '../src/agent/index.js';
import { createTunnelRegistry, type TunnelRegistry } from '../src/hub/index.js';
import {
  TUNNEL_BEARER_PROTOCOL_PREFIX,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type AgentInfo,
} from '../src/index.js';

const HUB_TOKEN = 'hub-token';
const LOCAL_WS_PATH = '/api/v1/ws';

/* --------------------------------- harnesses -------------------------------- */

interface HubHarness {
  url: string;
  registry: TunnelRegistry;
  close(): Promise<void>;
}

async function startHub(options?: {
  trustAnyToken?: boolean;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Fixed bind port (default ephemeral) — used to re-listen where a hub died. */
  port?: number;
}): Promise<HubHarness> {
  const registry = createTunnelRegistry({
    token: HUB_TOKEN,
    trustAnyToken: options?.trustAnyToken,
    helloTimeoutMs: options?.helloTimeoutMs ?? 2_000,
    requestTimeoutMs: options?.requestTimeoutMs ?? 2_000,
  });
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      for (const protocol of protocols) {
        if (protocol.startsWith(TUNNEL_BEARER_PROTOCOL_PREFIX)) return protocol;
      }
      return false;
    },
  });
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === undefined || !req.url.startsWith(TUNNEL_PATH)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      registry.handleConnection(ws);
    });
  });
  server.listen(options?.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    registry,
    close: () => closeServer(server, wss),
  };
}

interface LocalSlowRoute {
  started: number;
  aborted: boolean;
  responded: boolean;
}

interface LocalHarness {
  httpBase: string;
  token: string;
  /** Subprotocols observed by the echo endpoint, one per accepted socket. */
  wsProtocolsSeen: string[];
  slow: LocalSlowRoute;
  close(): Promise<void>;
}

async function startLocal(): Promise<LocalHarness> {
  const token = 'local-token';
  const slow: LocalSlowRoute = { started: 0, aborted: false, responded: false };
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
    if (req.url === '/api/v1/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/v1/echo' && req.method === 'POST') {
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
    if (req.url === '/slow') {
      slow.started += 1;
      const timer = setTimeout(() => {
        slow.responded = true;
        res.end('slow done');
      }, 5_000);
      res.on('close', () => {
        if (!res.writableEnded) {
          clearTimeout(timer);
          slow.aborted = true;
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== LOCAL_WS_PATH) {
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
    token,
    wsProtocolsSeen,
    slow,
    close: () => closeServer(server, echoWss),
  };
}

async function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
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

/* --------------------------------- helpers ---------------------------------- */

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

function connectAgent(options: {
  hubUrl: string;
  token?: string;
  agent?: Partial<AgentInfo>;
  local: { httpBase: string; token?: string };
  reconnect?: boolean;
  states?: TunnelClientState[];
}): TunnelClientHandle {
  return startTunnelClient({
    hubUrl: options.hubUrl,
    token: options.token ?? HUB_TOKEN,
    agent: options.agent ?? {},
    local: options.local,
    reconnect: options.reconnect,
    onState: (state) => options.states?.push(state),
  });
}

/* ----------------------------------- tests ---------------------------------- */

describe('remote-tunnel', () => {
  it('rejects a connector with the wrong token and stops retrying', async () => {
    const hub = await startHub();
    const states: TunnelClientState[] = [];
    const client = connectAgent({
      hubUrl: hub.url,
      token: 'wrong-token',
      local: { httpBase: 'http://127.0.0.1:9' }, // unreachable on purpose — never used
      states,
    });
    try {
      await waitFor(() => states.some((s) => s.kind === 'rejected'));
      expect(states.at(-1)).toMatchObject({ kind: 'rejected' });
      expect(hub.registry.list()).toEqual([]);
      // `rejected` is terminal: give a reconnect window and assert no retry happened.
      await sleep(300);
      expect(states.filter((s) => s.kind === 'reconnecting')).toEqual([]);
      expect(hub.registry.list()).toEqual([]);
    } finally {
      await client.close();
      await hub.close();
    }
    expect(states.at(-1)).toEqual({ kind: 'closed' });
  });

  it('registers the agent with filled defaults and tunnels HTTP requests', async () => {
    const hub = await startHub();
    const local = await startLocal();
    const states: TunnelClientState[] = [];
    let changes = 0;
    const unsubscribe = hub.registry.onChange(() => {
      changes += 1;
    });
    // Trailing slash exercises hubUrl normalization.
    const client = connectAgent({
      hubUrl: `${hub.url}/`,
      local: { httpBase: local.httpBase, token: local.token },
      states,
    });
    try {
      await waitFor(() => states.some((s) => s.kind === 'connected'));
      expect(changes).toBe(1);
      const agentId = client.agentId();
      expect(agentId).toBeDefined();

      const listed = hub.registry.list();
      expect(listed).toHaveLength(1);
      const info = listed[0]!;
      expect(info.agentId).toBe(agentId);
      expect(info.name).toBe(hostname());
      expect(info.platform).toBe(process.platform);
      expect(info.arch).toBe(process.arch);
      expect(info.pid).toBe(process.pid);
      expect(info.cwd).toBe(process.cwd());
      expect(info.version).toBeUndefined();
      expect(info.connectedAt).toBeGreaterThan(0);
      expect(hub.registry.get(agentId!)).toEqual(info);

      const health = await hub.registry.httpRequest(agentId!, {
        method: 'GET',
        path: '/api/v1/healthz',
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body.toString('utf8'))).toEqual({ ok: true });

      const echo = await hub.registry.httpRequest(agentId!, {
        method: 'POST',
        path: '/api/v1/echo',
        headers: { authorization: `Bearer ${HUB_TOKEN}`, 'content-type': 'text/plain' },
        body: Buffer.from('hello agent', 'utf8'),
      });
      expect(echo.status).toBe(200);
      expect(echo.body.toString('utf8')).toBe('hello agent');
      // The caller's Authorization must be REPLACED by the loopback token.
      expect(echo.headers['x-auth-seen']).toBe(`Bearer ${local.token}`);

      await expect(
        hub.registry.httpRequest('missing-agent', { method: 'GET', path: '/api/v1/healthz' }),
      ).rejects.toMatchObject({ name: 'TunnelError', code: 'agent_not_found' });
      expect(hub.registry.get('missing-agent')).toBeUndefined();
    } finally {
      await client.close();
      await hub.close();
      await local.close();
    }
    expect(changes).toBe(2);
    expect(states.at(-1)).toEqual({ kind: 'closed' });
    unsubscribe();
  });

  it('routes a connector `notify` frame to hub onNotify listeners', async () => {
    const hub = await startHub();
    const local = await startLocal();
    const states: TunnelClientState[] = [];
    const received: { frame: unknown; agent: unknown }[] = [];
    const unsubscribe = hub.registry.onNotify((frame, agent) => {
      received.push({ frame, agent });
    });
    const client = connectAgent({
      hubUrl: hub.url,
      local: { httpBase: local.httpBase, token: local.token },
      states,
    });
    try {
      await waitFor(() => states.some((s) => s.kind === 'connected'));
      client.notify({
        notificationId: 'ntf-1',
        sessionId: 'ses-9',
        agentId: 'main',
        title: 'needs you',
        body: 'the build failed',
      });
      await waitFor(() => received.length === 1);
      expect(received[0]).toMatchObject({
        frame: {
          type: 'notify',
          notificationId: 'ntf-1',
          sessionId: 'ses-9',
          title: 'needs you',
        },
        agent: { agentId: client.agentId(), name: hostname() },
      });
    } finally {
      await client.close();
      await hub.close();
      await local.close();
      unsubscribe();
    }
  });

  it('carries the declared session scope through the hello into the registry', async () => {
    const hub = await startHub();
    const local = await startLocal();
    const scope = { sessions: ['session-a', 'session-b'] };
    const client = connectAgent({
      hubUrl: hub.url,
      agent: { scope },
      local: { httpBase: local.httpBase, token: local.token },
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      const agentId = client.agentId()!;
      // list() and get() expose the identical scoped info (HubAgentInfo is a
      // spread of the connector's AgentInfo).
      const listed = hub.registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.scope).toEqual(scope);
      expect(hub.registry.get(agentId)).toEqual(listed[0]);
    } finally {
      await client.close();
      await hub.close();
      await local.close();
    }
  });

  it('applies a pre-connect updateScope to the first hello', async () => {
    const hub = await startHub();
    const local = await startLocal();
    const client = connectAgent({
      hubUrl: hub.url,
      agent: { scope: { sessions: ['session-a'] } },
      local: { httpBase: local.httpBase, token: local.token },
    });
    // The socket cannot be OPEN synchronously after startTunnelClient returns,
    // so this only records the wanted scope — the hello below carries it.
    client.updateScope(['session-a', 'session-b']);
    try {
      await waitFor(() => client.agentId() !== undefined);
      expect(hub.registry.get(client.agentId()!)?.scope).toEqual({
        sessions: ['session-a', 'session-b'],
      });
    } finally {
      await client.close();
      await hub.close();
      await local.close();
    }
  });

  it('scope.update rewrites the registry scope, and the reconnect hello re-declares the latest', async () => {
    let hub = await startHub();
    const local = await startLocal();
    let changes = 0;
    const unsubscribe = hub.registry.onChange(() => {
      changes += 1;
    });
    const client = connectAgent({
      hubUrl: hub.url,
      agent: { scope: { sessions: ['session-a'] } },
      local: { httpBase: local.httpBase, token: local.token },
      reconnect: true,
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      const agentId = client.agentId()!;
      expect(hub.registry.get(agentId)?.scope).toEqual({ sessions: ['session-a'] });
      expect(changes).toBe(1);

      // Connected: the frame crosses the tunnel and both read paths swap the set.
      client.updateScope(['session-a', 'session-b']);
      await waitFor(() => hub.registry.get(agentId)?.scope?.sessions.length === 2);
      expect(hub.registry.get(agentId)?.scope).toEqual({ sessions: ['session-a', 'session-b'] });
      expect(hub.registry.list()[0]!.scope).toEqual({ sessions: ['session-a', 'session-b'] });
      expect(changes).toBe(2);

      // While disconnected the frame is a no-op, but the wanted scope is
      // tracked — the reconnect hello to a re-listened hub declares it.
      const port = Number(new URL(hub.url).port);
      await hub.close();
      client.updateScope(['session-b']);
      hub = await startHub({ port });
      await waitFor(() => hub.registry.list().length === 1, 15_000);
      expect(client.agentId()).toBeDefined();
      expect(hub.registry.list()[0]!.scope).toEqual({ sessions: ['session-b'] });
      expect(hub.registry.get(client.agentId()!)?.scope).toEqual({ sessions: ['session-b'] });
    } finally {
      await client.close();
      await hub.close();
      await local.close();
      unsubscribe();
    }
  });

  it('registers an agent without scope as unscoped (legacy whole-machine)', async () => {
    const hub = await startHub();
    const local = await startLocal();
    const client = connectAgent({
      hubUrl: hub.url,
      local: { httpBase: local.httpBase, token: local.token },
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      expect(hub.registry.list()[0]!.scope).toBeUndefined();
    } finally {
      await client.close();
      await hub.close();
      await local.close();
    }
  });

  it('relays virtual WebSocket traffic both ways, text and binary', async () => {
    const hub = await startHub();
    const local = await startLocal();
    const client = connectAgent({
      hubUrl: hub.url,
      local: { httpBase: local.httpBase, token: local.token },
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      const agentId = client.agentId()!;

      const received: Array<{ data: Buffer; binary: boolean }> = [];
      let closed: { code?: number; reason?: string } | undefined;
      const relay = await hub.registry.openAgentWs(agentId, LOCAL_WS_PATH, {
        onMessage: (data, binary) => received.push({ data, binary }),
        onClose: (code, reason) => {
          closed = { code, reason };
        },
      });

      relay.send('hello tunnel');
      await waitFor(() => received.length === 1);
      expect(received[0]!.data.toString('utf8')).toBe('hello tunnel');
      expect(received[0]!.binary).toBe(false);

      relay.send(Buffer.from([1, 2, 3]));
      await waitFor(() => received.length === 2);
      expect(received[1]!.data.equals(Buffer.from([1, 2, 3]))).toBe(true);
      expect(received[1]!.binary).toBe(true);

      // The loopback server saw the agent-local bearer subprotocol, not the hub token.
      expect(local.wsProtocolsSeen).toEqual([`kimi-code.bearer.${local.token}`]);

      relay.close(1000, 'done');
      await waitFor(() => closed !== undefined);
      expect(closed).toEqual({ code: 1000, reason: 'done' });
    } finally {
      await client.close();
      await hub.close();
      await local.close();
    }
  });

  it('rejects in-flight requests when the agent disconnects', async () => {
    const hub = await startHub({ requestTimeoutMs: 5_000 });
    const local = await startLocal();
    const client = connectAgent({
      hubUrl: hub.url,
      local: { httpBase: local.httpBase, token: local.token },
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      const agentId = client.agentId()!;
      const pending = hub.registry.httpRequest(agentId, { method: 'GET', path: '/slow' });
      const rejection = expect(pending).rejects.toMatchObject({
        name: 'TunnelError',
        code: 'agent_disconnected',
      });
      await waitFor(() => local.slow.started === 1);
      await client.close();
      await rejection;
      expect(hub.registry.list()).toEqual([]);
    } finally {
      await hub.close();
      await local.close();
    }
  });

  it('aborts the loopback fetch when the hub times a request out', async () => {
    const hub = await startHub({ requestTimeoutMs: 300 });
    const local = await startLocal();
    const client = connectAgent({
      hubUrl: hub.url,
      local: { httpBase: local.httpBase, token: local.token },
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      const pending = hub.registry.httpRequest(client.agentId()!, {
        method: 'GET',
        path: '/slow',
      });
      await expect(pending).rejects.toMatchObject({ name: 'TunnelError', code: 'timeout' });
      // The hub's `http.abort` must kill the agent's loopback fetch.
      await waitFor(() => local.slow.aborted);
      expect(local.slow.responded).toBe(false);
    } finally {
      await client.close();
      await hub.close();
      await local.close();
    }
  });
});

/**
 * `trustAnyToken` (the hub's `--dangerous-bypass-auth`): both credential gates
 * — the negotiated `kimi-hub.bearer.*` subprotocol and `hello.token` — are
 * skipped; the protocol version check still rejects.
 */
describe('trustAnyToken', () => {
  it('registers a connector with the WRONG token (both gates skipped)', async () => {
    const hub = await startHub({ trustAnyToken: true });
    const states: TunnelClientState[] = [];
    const client = connectAgent({
      hubUrl: hub.url,
      token: 'wrong-token',
      local: { httpBase: 'http://127.0.0.1:9' }, // unreachable on purpose — never used
      states,
    });
    try {
      await waitFor(() => client.agentId() !== undefined);
      expect(hub.registry.list()).toHaveLength(1);
    } finally {
      await client.close();
      await hub.close();
    }
    expect(states.at(-1)).toEqual({ kind: 'closed' });
  });

  it('registers a raw connector with NO subprotocol and NO hello.token', async () => {
    const hub = await startHub({ trustAnyToken: true });
    const ws = new WebSocket(`${hub.url.replace(/^http/, 'ws')}${TUNNEL_PATH}`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8'))));
    try {
      await once(ws, 'open');
      expect(ws.protocol).toBe(''); // no bearer subprotocol negotiated at all
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: TUNNEL_PROTOCOL_VERSION,
          agent: { name: 'raw-tokenless-agent', platform: 'test-platform', arch: 'test-arch' },
        }),
      );
      await waitFor(() => frames.some((frame) => frame['type'] === 'hello.ack'));
      expect(hub.registry.list().map((agent) => agent.name)).toEqual(['raw-tokenless-agent']);
    } finally {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await once(ws, 'close');
      }
      await hub.close();
    }
  });

  it('still rejects a protocolVersion mismatch', async () => {
    const hub = await startHub({ trustAnyToken: true });
    const ws = new WebSocket(`${hub.url.replace(/^http/, 'ws')}${TUNNEL_PATH}`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8'))));
    try {
      await once(ws, 'open');
      // Attach 'close' up front: the reject frame and the close frame can land
      // in the same socket read, before waitFor's next poll tick.
      const closed = once(ws, 'close') as Promise<[number, Buffer]>;
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: TUNNEL_PROTOCOL_VERSION + 1,
          token: HUB_TOKEN,
          agent: { name: 'raw-bad-version', platform: 'test-platform', arch: 'test-arch' },
        }),
      );
      await waitFor(() => frames.some((frame) => frame['type'] === 'hello.reject'));
      const [code] = await closed;
      expect(code).toBe(4401);
      expect(hub.registry.list()).toEqual([]);
    } finally {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        await once(ws, 'close');
      }
      await hub.close();
    }
  });
});
