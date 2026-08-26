/**
 * Agent-side tunnel client — the outbound dial behind `kimi remote connect`.
 *
 * One WebSocket out to the hub's `TUNNEL_PATH` (NAT/firewall safe: nothing
 * listens on a reachable port) carries `hello` registration plus multiplexed
 * `http.req`/`ws.open` traffic, which is executed against the agent's
 * loopback kap-server and relayed back frame-for-frame.
 *
 * Auth + hop-by-hop hygiene: the caller's `Authorization`, `Host`,
 * `Connection`, and framing headers never cross the tunnel — the local token
 * is injected here. On reconnect the hub assigns a fresh per-connection
 * `agentId`; in-flight requests are dropped (the hub rejects them on its
 * side) and virtual relays are torn down locally.
 */

import { hostname } from 'node:os';

import { WebSocket, type RawData } from 'ws';

import {
  decodeB64,
  encodeB64,
  encodeFrame,
  MAX_TUNNELED_BODY_BYTES,
  parseHubFrame,
  TUNNEL_BEARER_PROTOCOL_PREFIX,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  type AgentInfo,
  type ConnectorFrame,
  type HttpRequestFrame,
  type HubFrame,
  type NotifyFrame,
  type WsCloseFrame,
  type WsMessageFrame,
  type WsOpenFrame,
} from '#/protocol';

// `kimi-code.bearer.` is kap-server's WebSocket bearer-auth subprotocol
// channel on /api/v1/ws (browser WebSockets cannot set headers, so the token
// rides the negotiated subprotocol). Duplicated by value on purpose: this
// package must stay free of any kap-server import.
const KAP_SERVER_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER = 0.1;

/**
 * Request headers that must never be replayed against the loopback server:
 * hop-by-hop/framing headers it owns, plus the caller's `Authorization`
 * (replaced by the agent-local token below).
 */
const REQUEST_HEADER_DENYLIST = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

/** Response headers that are invalid after undici re-framed the body. */
const RESPONSE_HEADER_DENYLIST = new Set([
  'content-encoding', // undici already decompressed the body
  'content-length',
  'connection',
  'transfer-encoding',
]);

export type TunnelClientState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly agentId: string }
  | { readonly kind: 'reconnecting'; readonly attempt: number; readonly nextDelayMs: number }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'closed' };

export interface TunnelClientOptions {
  /** `http(s)://` or `ws(s)://` hub origin; `TUNNEL_PATH` is appended when missing. */
  readonly hubUrl: string;
  /** Shared hub credential (bearer subprotocol + `hello.token`). */
  readonly token: string;
  /** Advertised agent info; missing fields default to this host's values. */
  readonly agent: Partial<AgentInfo>;
  readonly local: {
    /** Base of the loopback kap-server, e.g. `http://127.0.0.1:7777`. */
    readonly httpBase: string;
    /** Defaults to `httpBase` with a `ws(s)` scheme. */
    readonly wsBase?: string;
    /** Injected as the loopback kap-server credential, replacing any caller auth. */
    readonly token?: string;
  };
  /** Default true: retry with exponential backoff until `close()`. */
  readonly reconnect?: boolean;
  readonly onState?: (state: TunnelClientState) => void;
}

export interface TunnelClientHandle {
  close(): Promise<void>;
  agentId(): string | undefined;
  /**
   * Replace the session scope the hub enforces for this connection
   * ("scope follow"). The latest wanted scope is tracked: while connected it
   * is emitted verbatim as a `scope.update` frame (no cap enforcement here —
   * trimming is the caller's job), and every future reconnect's hello
   * re-declares it. Before the connection is established the frame is a no-op
   * — the hello sent on connect already carries the tracked latest.
   */
  updateScope(sessions: readonly string[]): void;
  /**
   * Push an out-of-band USER notification to the hub (it fans out to the open
   * hub-web pages). Fire-and-forget: a disconnected/never-connected client
   * drops the frame — a missed notification is never re-queued locally.
   */
  notify(frame: Omit<NotifyFrame, 'type'>): void;
}

export function startTunnelClient(options: TunnelClientOptions): TunnelClientHandle {
  return new TunnelClient(options);
}

interface VirtualSocketState {
  socket: WebSocket | undefined;
  opened: boolean;
  closed: boolean;
  /** Hub payloads awaiting the local socket's open, in order. */
  queue: Array<{ data: Buffer; binary: boolean }>;
}

class TunnelClient implements TunnelClientHandle {
  private readonly url: string;
  private readonly token: string;
  private readonly agentInfo: AgentInfo;
  private readonly httpBase: string;
  private readonly wsBase: string;
  private readonly localToken: string | undefined;
  private readonly reconnect: boolean;
  private readonly onState: ((state: TunnelClientState) => void) | undefined;

  private socket: WebSocket | undefined;
  private currentAgentId: string | undefined;
  private closed = false;
  private rejected = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError: string | undefined;
  /**
   * The latest scope handed to `updateScope`; `undefined` until the first
   * call, in which case the constructor's `options.agent.scope` still applies.
   * Re-read on every hello so a reconnect re-declares it.
   */
  private wantedScopeSessions: readonly string[] | undefined;
  private readonly httpControllers = new Map<string, AbortController>();
  private readonly virtualSockets = new Map<string, VirtualSocketState>();

  constructor(options: TunnelClientOptions) {
    this.url = normalizeTunnelUrl(options.hubUrl);
    this.token = options.token;
    this.agentInfo = fillAgentDefaults(options.agent);
    this.httpBase = stripTrailingSlash(options.local.httpBase);
    this.wsBase = stripTrailingSlash(
      options.local.wsBase ?? toWsBase(options.local.httpBase),
    );
    this.localToken = options.local.token;
    this.reconnect = options.reconnect ?? true;
    this.onState = options.onState;
    this.connect();
  }

  agentId(): string | undefined {
    return this.currentAgentId;
  }

  updateScope(sessions: readonly string[]): void {
    this.wantedScopeSessions = [...sessions];
    this.sendFrame({ type: 'scope.update', sessions: [...sessions] });
  }

  notify(frame: Omit<NotifyFrame, 'type'>): void {
    this.sendFrame({ type: 'notify', ...frame });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Detach first so in-flight handlers can no longer write to the socket,
    // then drop local request/relay state and emit the terminal state.
    const socket = this.socket;
    this.socket = undefined;
    this.resetConnectionState();
    this.emitState({ kind: 'closed' });
    if (socket !== undefined && socket.readyState < WebSocket.CLOSING) {
      const socketClosed = new Promise<void>((resolve) => {
        socket.once('close', () => {
          resolve();
        });
      });
      const fallback = setTimeout(() => {
        socket.terminate();
      }, 1_000);
      fallback.unref?.();
      socket.close();
      await socketClosed;
      clearTimeout(fallback);
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.emitState({ kind: 'connecting' });
    const socket = new WebSocket(this.url, [TUNNEL_BEARER_PROTOCOL_PREFIX + this.token]);
    this.socket = socket;
    let helloSettled = false;

    socket.on('open', () => {
      this.sendFrame({
        type: 'hello',
        protocolVersion: TUNNEL_PROTOCOL_VERSION,
        token: this.token,
        agent: this.helloAgentInfo(),
      });
    });
    socket.on('message', (data: RawData) => {
      const frame = parseHubFrame(rawDataToString(data));
      if (frame === undefined) return;
      if (!helloSettled) {
        helloSettled = true;
        if (frame.type === 'hello.ack') {
          this.attempt = 0;
          this.currentAgentId = frame.agentId;
          this.emitState({ kind: 'connected', agentId: frame.agentId });
        } else if (frame.type === 'hello.reject') {
          this.rejected = true;
          this.emitState({ kind: 'rejected', reason: frame.reason });
          socket.close();
        } else {
          // Protocol violation during the handshake — drop the connection.
          socket.close();
        }
        return;
      }
      this.onFrame(frame);
    });
    socket.on('error', (error: Error) => {
      // 'close' always follows; reconnect decisions live there.
      this.lastError = error.message;
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.resetConnectionState();
      if (this.closed || this.rejected) return;
      if (!this.reconnect) {
        this.closed = true;
        this.emitState({ kind: 'error', message: this.lastError ?? 'connection closed' });
        return;
      }
      this.attempt += 1;
      const base = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** (this.attempt - 1),
        RECONNECT_MAX_DELAY_MS,
      );
      const nextDelayMs = Math.round(
        base * (1 - RECONNECT_JITTER + Math.random() * 2 * RECONNECT_JITTER),
      );
      this.emitState({ kind: 'reconnecting', attempt: this.attempt, nextDelayMs });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.connect();
      }, nextDelayMs);
      this.reconnectTimer.unref?.();
    });
  }

  /**
   * Per-hello agent info: the latest `updateScope` set wins over the
   * constructor's `options.agent.scope`, so a reconnect declares the CURRENT
   * wanted scope rather than the one frozen at connect time.
   */
  private helloAgentInfo(): AgentInfo {
    const sessions = this.wantedScopeSessions;
    if (sessions === undefined) return this.agentInfo;
    return { ...this.agentInfo, scope: { sessions: [...sessions] } };
  }

  /** Drop everything tied to the (now dead) connection — the hub owns server-side rejection. */
  private resetConnectionState(): void {
    this.currentAgentId = undefined;
    for (const controller of this.httpControllers.values()) controller.abort();
    this.httpControllers.clear();
    for (const virtual of this.virtualSockets.values()) virtual.socket?.terminate();
    this.virtualSockets.clear();
  }

  private onFrame(frame: HubFrame): void {
    switch (frame.type) {
      case 'hello.ack':
      case 'hello.reject':
        return; // handshake already settled
      case 'http.req':
        void this.onHttpRequest(frame);
        return;
      case 'http.abort':
        this.httpControllers.get(frame.id)?.abort();
        return;
      case 'ws.open':
        this.onWsOpen(frame);
        return;
      case 'ws.msg':
        this.onWsMessage(frame);
        return;
      case 'ws.close':
        this.onWsClose(frame);
        return;
    }
  }

  private async onHttpRequest(frame: HttpRequestFrame): Promise<void> {
    const controller = new AbortController();
    this.httpControllers.set(frame.id, controller);
    try {
      const response = await fetch(this.httpBase + frame.path, {
        // Redirects belong to the caller: relay the 3xx verbatim instead.
        redirect: 'manual',
        method: frame.method,
        headers: sanitizeRequestHeaders(frame.headers, this.localToken),
        body: frame.bodyB64 !== undefined ? decodeB64(frame.bodyB64) : undefined,
        signal: controller.signal,
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > MAX_TUNNELED_BODY_BYTES) {
        this.sendHttpResponse(
          frame.id,
          502,
          TEXT_HEADERS,
          Buffer.from(`tunneled response exceeds ${MAX_TUNNELED_BODY_BYTES} bytes`, 'utf8'),
        );
        return;
      }
      this.sendHttpResponse(
        frame.id,
        response.status,
        sanitizeResponseHeaders(response.headers),
        body,
      );
    } catch (error) {
      // Hub-initiated abort (or tunnel teardown): the hub already gave up on
      // this id, so there is nothing to answer.
      if (controller.signal.aborted) return;
      this.sendHttpResponse(
        frame.id,
        502,
        TEXT_HEADERS,
        Buffer.from(`tunnel fetch failed: ${errorMessage(error)}`, 'utf8'),
      );
    } finally {
      this.httpControllers.delete(frame.id);
    }
  }

  private sendHttpResponse(
    id: string,
    status: number,
    headers: Record<string, string>,
    body: Buffer,
  ): void {
    this.sendFrame({
      type: 'http.res',
      id,
      status,
      headers,
      bodyB64: body.byteLength > 0 ? encodeB64(body) : undefined,
    });
  }

  private onWsOpen(frame: WsOpenFrame): void {
    const state: VirtualSocketState = { socket: undefined, opened: false, closed: false, queue: [] };
    this.virtualSockets.set(frame.id, state);
    const protocols =
      this.localToken !== undefined
        ? [KAP_SERVER_BEARER_PROTOCOL_PREFIX + this.localToken]
        : [];
    const socket = new WebSocket(this.wsBase + frame.path, protocols);
    state.socket = socket;

    socket.on('open', () => {
      state.opened = true;
      this.sendFrame({ type: 'ws.opened', id: frame.id });
      for (const queued of state.queue) {
        socket.send(queued.data, { binary: queued.binary });
      }
      state.queue = [];
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      this.sendFrame({
        type: 'ws.msg',
        id: frame.id,
        dataB64: encodeB64(rawDataToBuffer(data)),
        binary: isBinary ? true : undefined,
      });
    });
    socket.on('error', (error: Error) => {
      if (!state.opened) {
        this.sendFrame({ type: 'ws.error', id: frame.id, message: error.message });
      }
      // 'close' always follows and owns cleanup.
    });
    socket.on('close', (code: number, reason: Buffer) => {
      if (state.closed) return;
      state.closed = true;
      this.virtualSockets.delete(frame.id);
      this.sendFrame({
        type: 'ws.close',
        id: frame.id,
        code,
        reason: reason.length > 0 ? reason.toString('utf8') : undefined,
      });
    });
  }

  private onWsMessage(frame: WsMessageFrame): void {
    const state = this.virtualSockets.get(frame.id);
    if (state === undefined || state.closed) return;
    const queued = { data: decodeB64(frame.dataB64), binary: frame.binary ?? false };
    if (state.opened && state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(queued.data, { binary: queued.binary });
    } else {
      state.queue.push(queued);
    }
  }

  private onWsClose(frame: WsCloseFrame): void {
    const state = this.virtualSockets.get(frame.id);
    if (state === undefined || state.closed) return;
    // The local 'close' event sends the mirrored `ws.close` back to the hub.
    state.socket?.close(frame.code ?? 1000, frame.reason);
  }

  private sendFrame(frame: ConnectorFrame): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(encodeFrame(frame));
    } catch {
      // best-effort; the close event owns teardown
    }
  }

  private emitState(state: TunnelClientState): void {
    this.onState?.(state);
  }
}

const TEXT_HEADERS: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };

/** `http(s)://host[/...]` → `ws(s)://host/internal/tunnel`, idempotent. */
function normalizeTunnelUrl(hubUrl: string): string {
  let url = stripTrailingSlash(hubUrl.trim());
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  if (!url.endsWith(TUNNEL_PATH)) url += TUNNEL_PATH;
  return url;
}

function toWsBase(httpBase: string): string {
  return httpBase.replace(/^http/, 'ws');
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function fillAgentDefaults(agent: Partial<AgentInfo>): AgentInfo {
  return {
    name: agent.name ?? hostname(),
    platform: agent.platform ?? process.platform,
    arch: agent.arch ?? process.arch,
    version: agent.version,
    cwd: agent.cwd ?? process.cwd(),
    // pid is NOT defaulted: declaring one is the agent's opt-in to being
    // hub-stoppable (kimi headless passes its own pid; interactive hosts like
    // the TUI `/remote connect` must never be killable through the hub).
    pid: agent.pid,
    scope: agent.scope,
  };
}

function sanitizeRequestHeaders(
  headers: Record<string, string>,
  localToken: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REQUEST_HEADER_DENYLIST.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  if (localToken !== undefined) out['authorization'] = `Bearer ${localToken}`;
  return out;
}

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (RESPONSE_HEADER_DENYLIST.has(key)) return;
    out[key] = value;
  });
  return out;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  return rawDataToBuffer(data).toString('utf8');
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
