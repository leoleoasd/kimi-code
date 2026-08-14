/**
 * Hub-side tunnel registry.
 *
 * Accepts outbound-connected agent sockets (one WebSocket per agent
 * connection, handed over from a `ws` `WebSocketServer({ noServer: true })`
 * upgrade), authenticates them via the `kimi-hub.bearer.<token>` subprotocol
 * or the `hello` frame's token, and multiplexes HTTP round trips plus virtual
 * WebSocket relays over each registered connection.
 *
 * Liveness: the hub sends protocol-level pings every `heartbeatMs`; a peer
 * with no inbound traffic at all (pongs included) for two full cycles is
 * terminated as half-open.
 */

import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import { TunnelError } from '#/errors';
import {
  decodeB64,
  encodeB64,
  encodeFrame,
  MAX_TUNNELED_BODY_BYTES,
  parseConnectorFrame,
  TUNNEL_BEARER_PROTOCOL_PREFIX,
  TUNNEL_HEARTBEAT_MS,
  TUNNEL_PROTOCOL_VERSION,
  type AgentInfo,
  type HelloFrame,
  type HttpResponseFrame,
  type HubFrame,
  type NotifyFrame,
} from '#/protocol';

/** Close code for every hello-phase failure (bad/missing token, bad version, timeout). */
const CLOSE_UNAUTHORIZED = 4401;

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Terminate the connection once no inbound frame has arrived for this many cycles. */
const HEARTBEAT_MISS_LIMIT = 2;

/** `AgentInfo` of a registered agent plus the per-connection id and timestamp. */
export type HubAgentInfo = AgentInfo & {
  readonly agentId: string;
  /** Epoch ms when the connection's hello was accepted. */
  readonly connectedAt: number;
};

export interface TunnelRegistryOptions {
  /** Shared credential checked against the bearer subprotocol or `hello.token`. */
  readonly token: string;
  /**
   * Trust mode (the hub's `--dangerous-bypass-auth`): both credential gates
   * are skipped — a mismatched or absent bearer subprotocol does not reject,
   * and `hello.token` may carry any value or be absent. Protocol version
   * validation is NOT affected.
   */
  readonly trustAnyToken?: boolean;
  readonly heartbeatMs?: number;
  readonly helloTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface TunnelHttpRequest {
  readonly method: string;
  /** Full path incl. `/api/v1/...` prefix and query string. */
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer;
}

export interface TunnelHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

export interface AgentWsSink {
  onMessage(data: Buffer, binary: boolean): void;
  onClose(code?: number, reason?: string): void;
}

/** Hub end of one virtual WebSocket relay. */
export interface AgentWsHandle {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

export interface TunnelRegistry {
  /** Take ownership of an upgraded agent socket (from `WebSocketServer` in `noServer` mode). */
  handleConnection(ws: WebSocket): void;
  list(): HubAgentInfo[];
  get(agentId: string): HubAgentInfo | undefined;
  /** Fires once per agent connect and disconnect; returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
  /**
   * Fires per agent `notify` frame (NotifyUser tool from the agent engine) —
   * carries the frame + the sending agent's info for display. Returns an
   * unsubscribe function.
   */
  onNotify(listener: (frame: NotifyFrame, agent: HubAgentInfo) => void): () => void;
  httpRequest(agentId: string, req: TunnelHttpRequest): Promise<TunnelHttpResponse>;
  openAgentWs(agentId: string, path: string, sink: AgentWsSink): Promise<AgentWsHandle>;
}

export function createTunnelRegistry(options: TunnelRegistryOptions): TunnelRegistry {
  return new HubTunnelRegistry(options);
}

interface PendingHttpRequest {
  readonly resolve: (res: TunnelHttpResponse) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface VirtualSocket {
  readonly sink: AgentWsSink;
  readonly resolveOpen: (handle: AgentWsHandle) => void;
  readonly rejectOpen: (err: Error) => void;
  /** The open handshake answered (`ws.opened` / `ws.error` / teardown). */
  openSettled: boolean;
  /** Close delivered once; entry removed from the owning connection. */
  closed: boolean;
}

interface AgentConnection {
  readonly agentId: string;
  /** Mutable: a `scope.update` frame rewrites the scope over a live connection. */
  info: AgentInfo;
  readonly connectedAt: number;
  readonly socket: WebSocket;
  readonly heartbeat: ReturnType<typeof setInterval>;
  /** Any inbound frame or pong proves the peer is alive. */
  lastInboundAt: number;
  closed: boolean;
  readonly pendingHttp: Map<string, PendingHttpRequest>;
  readonly virtualSockets: Map<string, VirtualSocket>;
}

class HubTunnelRegistry implements TunnelRegistry {
  private readonly token: string;
  private readonly trustAnyToken: boolean;
  private readonly heartbeatMs: number;
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly agents = new Map<string, AgentConnection>();
  private readonly listeners = new Set<() => void>();
  private readonly notifyListeners = new Set<(frame: NotifyFrame, agent: HubAgentInfo) => void>();

  constructor(options: TunnelRegistryOptions) {
    this.token = options.token;
    this.trustAnyToken = options.trustAnyToken === true;
    this.heartbeatMs = options.heartbeatMs ?? TUNNEL_HEARTBEAT_MS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  handleConnection(socket: WebSocket): void {
    // A hub-level reverse proxy may authenticate the socket at the upgrade via
    // the bearer subprotocol; the hello token is the fallback (and only)
    // credential channel otherwise.
    const bearerAuthed = socket.protocol === TUNNEL_BEARER_PROTOCOL_PREFIX + this.token;

    const helloTimer = setTimeout(() => {
      socket.close(CLOSE_UNAUTHORIZED, 'hello timeout');
    }, this.helloTimeoutMs);
    helloTimer.unref?.();

    const onFirstMessage = (data: RawData): void => {
      socket.off('message', onFirstMessage);
      clearTimeout(helloTimer);
      const frame = parseConnectorFrame(rawDataToString(data));
      if (frame?.type !== 'hello') {
        socket.close(CLOSE_UNAUTHORIZED, 'expected hello');
        return;
      }
      // Trust mode skips BOTH credential gates (subprotocol + hello token);
      // the protocol version check in register() still stands.
      if (!this.trustAnyToken && !bearerAuthed && frame.token !== this.token) {
        sendFrame(socket, { type: 'hello.reject', reason: 'invalid token' });
        socket.close(CLOSE_UNAUTHORIZED, 'invalid token');
        return;
      }
      this.register(socket, frame);
    };
    socket.on('message', onFirstMessage);
    // 'close' always follows; nothing is tracked yet at this stage.
    socket.on('error', () => {});
  }

  list(): HubAgentInfo[] {
    return Array.from(this.agents.values(), (conn) => toHubAgentInfo(conn));
  }

  get(agentId: string): HubAgentInfo | undefined {
    const conn = this.agents.get(agentId);
    return conn === undefined ? undefined : toHubAgentInfo(conn);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onNotify(listener: (frame: NotifyFrame, agent: HubAgentInfo) => void): () => void {
    this.notifyListeners.add(listener);
    return () => {
      this.notifyListeners.delete(listener);
    };
  }

  httpRequest(agentId: string, req: TunnelHttpRequest): Promise<TunnelHttpResponse> {
    const conn = this.agents.get(agentId);
    if (conn === undefined || conn.closed) {
      return Promise.reject(new TunnelError('agent_not_found', `unknown agent ${agentId}`));
    }
    if (req.body !== undefined && req.body.byteLength > MAX_TUNNELED_BODY_BYTES) {
      return Promise.reject(
        new TunnelError('oversize_body', `request body exceeds ${MAX_TUNNELED_BODY_BYTES} bytes`),
      );
    }
    const id = ulid();
    return new Promise<TunnelHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingHttp.delete(id);
        // Best-effort: stop the agent-side fetch behind this id as well.
        sendFrame(conn.socket, { type: 'http.abort', id });
        reject(new TunnelError('timeout', `request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      conn.pendingHttp.set(id, { resolve, reject, timer });
      sendFrame(conn.socket, {
        type: 'http.req',
        id,
        method: req.method,
        path: req.path,
        headers: req.headers ?? {},
        bodyB64: req.body !== undefined ? encodeB64(req.body) : undefined,
      });
    });
  }

  openAgentWs(agentId: string, path: string, sink: AgentWsSink): Promise<AgentWsHandle> {
    const conn = this.agents.get(agentId);
    if (conn === undefined || conn.closed) {
      return Promise.reject(new TunnelError('agent_not_found', `unknown agent ${agentId}`));
    }
    const id = ulid();
    return new Promise<AgentWsHandle>((resolveOpen, rejectOpen) => {
      conn.virtualSockets.set(id, {
        sink,
        resolveOpen,
        rejectOpen,
        openSettled: false,
        closed: false,
      });
      sendFrame(conn.socket, { type: 'ws.open', id, path });
    });
  }

  private register(socket: WebSocket, hello: HelloFrame): void {
    if (hello.protocolVersion !== TUNNEL_PROTOCOL_VERSION) {
      sendFrame(socket, {
        type: 'hello.reject',
        reason: `unsupported protocol version ${hello.protocolVersion}`,
      });
      socket.close(CLOSE_UNAUTHORIZED, 'protocol version mismatch');
      return;
    }
    const agentId = ulid();
    const conn: AgentConnection = {
      agentId,
      info: hello.agent,
      connectedAt: Date.now(),
      socket,
      heartbeat: setInterval(() => {
        this.onHeartbeat(conn);
      }, this.heartbeatMs),
      lastInboundAt: Date.now(),
      closed: false,
      pendingHttp: new Map(),
      virtualSockets: new Map(),
    };
    conn.heartbeat.unref?.();
    this.agents.set(agentId, conn);
    socket.on('message', (data: RawData) => {
      this.onFrame(conn, data);
    });
    socket.on('pong', () => {
      conn.lastInboundAt = Date.now();
    });
    socket.on('close', () => {
      this.teardown(conn);
    });
    socket.on('error', () => {
      // 'close' always follows; teardown lives there.
    });
    sendFrame(socket, { type: 'hello.ack', agentId, heartbeatMs: this.heartbeatMs });
    this.emitChange();
  }

  private onHeartbeat(conn: AgentConnection): void {
    // Reap first: a peer silent for two full cycles is half-open (laptop
    // asleep, network silently gone) — terminate instead of pinging a dead pipe.
    if (Date.now() - conn.lastInboundAt >= this.heartbeatMs * HEARTBEAT_MISS_LIMIT) {
      conn.socket.terminate();
      return;
    }
    try {
      conn.socket.ping();
    } catch {
      // Socket is dying regardless; its close event owns teardown.
    }
  }

  private onFrame(conn: AgentConnection, data: RawData): void {
    const frame = parseConnectorFrame(rawDataToString(data));
    if (frame === undefined) return;
    conn.lastInboundAt = Date.now();
    switch (frame.type) {
      case 'hello':
        return; // one hello per connection; a duplicate is a no-op.
      case 'scope.update': {
        // Scope follow ("Claude Code /resume" semantics): the connector's
        // current wanted scope replaces the hello-declared one wholesale;
        // roster listeners (and every later get/list/read) see the new set.
        conn.info = { ...conn.info, scope: { sessions: [...frame.sessions] } };
        this.emitChange();
        return;
      }
      case 'http.res': {
        this.onHttpResponse(conn, frame);
        return;
      }
      case 'notify': {
        const agent = toHubAgentInfo(conn);
        for (const listener of this.notifyListeners) listener(frame, agent);
        return;
      }
      case 'ws.opened': {
        const virtual = conn.virtualSockets.get(frame.id);
        if (virtual === undefined || virtual.closed || virtual.openSettled) return;
        virtual.openSettled = true;
        virtual.resolveOpen(this.buildWsHandle(conn, frame.id));
        return;
      }
      case 'ws.error': {
        const virtual = conn.virtualSockets.get(frame.id);
        if (virtual === undefined || virtual.closed) return;
        virtual.closed = true;
        conn.virtualSockets.delete(frame.id);
        if (!virtual.openSettled) {
          virtual.openSettled = true;
          virtual.rejectOpen(new TunnelError('ws_open_failed', frame.message));
        } else {
          virtual.sink.onClose(1011, frame.message);
        }
        return;
      }
      case 'ws.msg': {
        const virtual = conn.virtualSockets.get(frame.id);
        if (virtual === undefined || virtual.closed) return;
        virtual.sink.onMessage(decodeB64(frame.dataB64), frame.binary ?? false);
        return;
      }
      case 'ws.close': {
        this.closeVirtual(conn, frame.id, false, frame.code, frame.reason);
        return;
      }
    }
  }

  private onHttpResponse(conn: AgentConnection, frame: HttpResponseFrame): void {
    const pending = conn.pendingHttp.get(frame.id);
    if (pending === undefined) return;
    conn.pendingHttp.delete(frame.id);
    clearTimeout(pending.timer);
    const body = frame.bodyB64 !== undefined ? decodeB64(frame.bodyB64) : Buffer.alloc(0);
    // Defense in depth: the connector is expected to answer 502 instead, but a
    // body this large must never resolve successfully here either.
    if (body.byteLength > MAX_TUNNELED_BODY_BYTES) {
      pending.reject(
        new TunnelError('oversize_body', `response body exceeds ${MAX_TUNNELED_BODY_BYTES} bytes`),
      );
      return;
    }
    pending.resolve({ status: frame.status, headers: frame.headers, body });
  }

  private buildWsHandle(conn: AgentConnection, id: string): AgentWsHandle {
    return {
      send: (data: string | Buffer): void => {
        const virtual = conn.virtualSockets.get(id);
        if (virtual === undefined || virtual.closed) return;
        // Strings ride as text frames, buffers as binary frames.
        const binary = typeof data !== 'string';
        sendFrame(conn.socket, {
          type: 'ws.msg',
          id,
          dataB64: encodeB64(typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
          binary: binary ? true : undefined,
        });
      },
      close: (code?: number, reason?: string): void => {
        this.closeVirtual(conn, id, true, code, reason);
      },
    };
  }

  /**
   * Shared close path for both relay directions: notify the local sink once,
   * and mirror `ws.close` to the agent only when the hub initiated the close
   * (the agent mirrors its own closes back already).
   */
  private closeVirtual(
    conn: AgentConnection,
    id: string,
    sendToAgent: boolean,
    code?: number,
    reason?: string,
  ): void {
    const virtual = conn.virtualSockets.get(id);
    if (virtual === undefined || virtual.closed) return;
    virtual.closed = true;
    conn.virtualSockets.delete(id);
    if (sendToAgent) {
      sendFrame(conn.socket, { type: 'ws.close', id, code, reason });
    }
    if (!virtual.openSettled) {
      virtual.openSettled = true;
      virtual.rejectOpen(new TunnelError('ws_open_failed', reason ?? 'relay closed'));
      return;
    }
    virtual.sink.onClose(code, reason);
  }

  /** Socket closed: reject every pending request and close every virtual relay. */
  private teardown(conn: AgentConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    clearInterval(conn.heartbeat);
    this.agents.delete(conn.agentId);
    const error = new TunnelError('agent_disconnected', `agent ${conn.agentId} disconnected`);
    for (const pending of conn.pendingHttp.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    conn.pendingHttp.clear();
    for (const virtual of conn.virtualSockets.values()) {
      if (virtual.closed) continue;
      virtual.closed = true;
      if (!virtual.openSettled) {
        virtual.openSettled = true;
        virtual.rejectOpen(error);
      } else {
        virtual.sink.onClose(1001, 'agent_disconnected');
      }
    }
    conn.virtualSockets.clear();
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

function sendFrame(socket: WebSocket, frame: HubFrame): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(encodeFrame(frame));
  } catch {
    // best-effort; the close event owns teardown
  }
}

function toHubAgentInfo(conn: AgentConnection): HubAgentInfo {
  return { ...conn.info, agentId: conn.agentId, connectedAt: conn.connectedAt };
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
