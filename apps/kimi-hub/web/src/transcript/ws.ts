/**
 * Minimal `/api/v1/ws` client for the transcript stream.
 *
 * The socket is used exclusively as an incremental channel. The subscription
 * grade is an option (default 'block'): 'block' drops the per-token `append`
 * frames (the bulk of transcript traffic) and still receives the whole-state
 * frame upserts at every flush point, so content converges without a REST
 * round-trip; the chat channel passes 'delta' so those `append` chunks also
 * flow and text frames render token-by-token. After the upgrade, the client sends
 * `client_hello`, then a `subscribe_v2` frame carrying the transcript grade
 * map (plus the `transcript_since` cursor when a watermark is known), and
 * forwards every `transcript.ops` frame to the consumer. Full state never
 * comes from here: `transcript.reset` snapshots are ignored because complete
 * data (initial load and any refresh) is read back from the REST transcript
 * API, paged from the tail backwards.
 *
 * Loss signals are surfaced, not repaired locally — transcript frames are
 * volatile by design (never journaled), so the consumer answers them with a
 * REST refresh or a `since_seq` catch-up: `resync_required` →
 * `onResyncRequired`, and the `subscribe_v2` ack after every established
 * socket → `onReconnected`.
 *
 * The hub token is presented at the upgrade through the
 * `kimi-hub.bearer.<token>` subprotocol — the only credential channel a
 * browser WebSocket has (the hub forwards the socket to the agent's
 * kap-server through the tunnel; the connector injects the agent-local
 * credential there).
 */

import {
  transcriptOpsEventSchema,
  type TranscriptGrade,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

/**
 * Minimal DOM-compatible WebSocket surface; coding against this structural
 * type keeps the client testable with an injected fake. The default is the
 * global `WebSocket` (browsers, Node ≥ 21).
 */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: never) => void,
  ): void;
}

export interface WsLikeCtor {
  new (url: string, protocols?: string | string[]): WsLike;
  readonly OPEN: number;
}

/** Envelope/payload metadata carried alongside a transcript frame (seq tracking). */
export interface TranscriptFrameMeta {
  /** Op-batch sequence number (payload `seq`); absent on legacy servers. */
  readonly seq?: number | undefined;
}

export interface TranscriptWsHandlers {
  /** Incremental L2 op batch for the agent (the only data frame consumed). */
  onOps: (agentId: string, ops: readonly TranscriptOperation[], meta?: TranscriptFrameMeta) => void;
  /** Server signalled desync for our session — consumer should REST-refresh. */
  onResyncRequired: () => void;
  /** Socket re-established after a drop — volatile ops were missed meanwhile. */
  onReconnected: () => void;
  /**
   * Global `session.meta.updated` frame — kap-server broadcasts these (rename,
   * first-prompt auto-title) to EVERY established connection without any
   * subscription, so they arrive on this socket too. The consumer refreshes
   * its own session-title caches; this layer owns no cache of its own.
   */
  onSessionMetaUpdated?: (meta: SessionMetaUpdated) => void;
  /**
   * `agent.created` / `agent.disposed` on our session — the REST transcript
   * page is the only source of the agent roster, so the consumer refetches it
   * (e.g. a newly spawned subagent joins the tab list without a manual
   * refresh).
   */
  onAgentLifecycle?: (kind: 'created' | 'disposed') => void;
}

/** The consumable bits of a global `session.meta.updated` frame. */
export interface SessionMetaUpdated {
  readonly sessionId: string;
  readonly title?: string;
}

export interface TranscriptWsOptions {
  /** Agent proxy base URL (`http(s)://hub/agents/{id}`) or a full `ws(s)://…` URL. */
  readonly url: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly handlers: TranscriptWsHandlers;
  /**
   * Returns the caller's current op-batch watermark at (re)subscribe time;
   * when defined it is sent as the `transcript_since` cursor so a sequenced
   * server replays missed batches instead of sending a baseline reset.
   */
  readonly getSince?: (() => number | undefined) | undefined;
  /**
   * Transcript grade for the `subscribe_v2` spec of this (session, agent).
   * Default 'block' (flush-point upserts only); the chat channel passes
   * 'delta' so `append` chunks stream token-by-token into the store.
   */
  readonly grade?: TranscriptGrade | undefined;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

interface ServerFrame {
  readonly type: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
  /**
   * Envelope session routing (`buildEnvelope`) — present on session-scoped
   * frames, including the globally fanned-out `session.meta.updated`.
   */
  readonly session_id?: string;
}

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-hub.bearer.';

export class TranscriptWs {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly handlers: TranscriptWsHandlers;
  private readonly getSince?: (() => number | undefined) | undefined;
  private readonly grade: TranscriptGrade;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private helloId: string | undefined;
  private subscribeV2Id: string | undefined;
  private subscribeV2Acked = false;

  constructor(opts: TranscriptWsOptions) {
    this.wsUrl = toWsUrl(opts.url);
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.handlers = opts.handlers;
    this.getSince = opts.getSince;
    this.grade = opts.grade ?? 'block';
    const ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsLikeCtor | undefined);
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WsCtor = ctor;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.connect();
  }

  /** Tear the socket down permanently. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private connect(): void {
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WsLike;
    try {
      ws = new this.WsCtor(this.wsUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.helloId = `kimi-hub-${Date.now().toString(36)}`;
      this.subscribeV2Id = `${this.helloId}-sub`;
      this.subscribeV2Acked = false;
      const since = this.getSince?.();
      this.send({
        type: 'client_hello',
        id: this.helloId,
        payload: {
          client_id: 'kimi-hub',
          subscriptions: [this.sessionId],
        },
      });
      // Transcript grades ride only `subscribe_v2` — sent right after the
      // hello on the same socket, so the server processes them in order.
      this.send({
        type: 'subscribe_v2',
        id: this.subscribeV2Id,
        payload: {
          session_id: this.sessionId,
          transcript: { [this.agentId]: this.grade },
          transcript_since: since !== undefined ? { [this.agentId]: since } : undefined,
        },
      });
      // The reconcile fires on the subscribe_v2 ACK (see onMessage) — the
      // server attaches the transcript stream only after processing
      // subscribe_v2, so refreshing at open could finish before the
      // subscription is active and still miss the ops in between.
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      // Stale socket (a manual close already cleared `this.ws`).
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // The 'close' event always follows 'error'; reconnect logic lives there.
    });
  }

  private onMessage(raw: unknown): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'ack': {
        // The subscribe_v2 ack: the server has attached the transcript stream
        // by now — reconcile once per socket (ops emitted between the REST
        // page load and this point are missed; the consumer refreshes).
        if (!this.subscribeV2Acked && frame.id !== undefined && frame.id === this.subscribeV2Id) {
          this.subscribeV2Acked = true;
          this.handlers.onReconnected();
        }
        return;
      }
      case 'transcript.ops': {
        const parsed = transcriptOpsEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.handlers.onOps(parsed.data.agent_id, parsed.data.ops, {
          seq: parsed.data.seq,
        });
        return;
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
        this.send({ type: 'pong', payload: { nonce } });
        return;
      }
      case 'resync_required': {
        const sessionId = (frame.payload as { session_id?: unknown } | undefined)?.session_id;
        if (sessionId === this.sessionId) this.handlers.onResyncRequired();
        return;
      }
      case 'agent.created':
      case 'agent.disposed': {
        // Frame type IS the event type; the envelope session matches our
        // socket's own scope (session-scoped agents may still see others'
        // frames before the filter bites, so compare id anyway).
        if (readNonEmptyString(frame.session_id) === this.sessionId) {
          this.handlers.onAgentLifecycle?.(frame.type === 'agent.created' ? 'created' : 'disposed');
        }
        return;
      }
      case 'session.meta.updated': {
        // Global fan-out: the envelope's `session_id` is the frame's
        // authoritative routing (the hub relay also scope-filters on it); the
        // payload re-stamps the same id camelCase and carries the new title.
        const payload = frame.payload as { sessionId?: unknown; title?: unknown } | undefined;
        const sessionId = readNonEmptyString(frame.session_id) ?? readNonEmptyString(payload?.sessionId);
        if (sessionId !== undefined) {
          this.handlers.onSessionMetaUpdated?.({
            sessionId,
            title: typeof payload?.title === 'string' ? payload.title : undefined,
          });
        }
        return;
      }
      default:
        // server_hello / non-subscribe acks / reset snapshots / legacy events.
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== this.WsCtor.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort; the close handler handles teardown
    }
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Derive the `/api/v1/ws` WebSocket URL from a base URL (or pass a full ws URL through). */
export function toWsUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v1/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
