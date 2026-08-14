/**
 * Live roster stream — `WS {hubOrigin}/hub/api/stream`. This endpoint is the
 * hub's OWN API, so frames are NOT envelope-wrapped (unlike `GET
 * /hub/api/agents`): on open the hub sends `{ type: 'roster', agents:
 * HubAgentInfo[] }` immediately and re-sends the full snapshot on every
 * roster change (agent connect/disconnect).
 *
 * The stream is an OVERLAY on the shared roster cache, not a replacement for
 * the 5s REST poll: both write `HUB_AGENTS_QUERY_KEY`, so consumers (`App`,
 * `SessionRail`) read one merged roster and stay correct while the socket is
 * down (the poll keeps refreshing on its own).
 *
 * Auth uses the same trick as the other hub websockets — a browser upgrade
 * carries no headers, so the token goes in as the `kimi-hub.bearer.<token>`
 * subprotocol, mirroring `TranscriptWs`.
 *
 * `RosterStream` owns the socket (connect/backoff/close) and the cache
 * writes; `useRosterStream` is the one-effect React adapter that additionally
 * exports the connection lifecycle as `{ online, rosterAge }` state.
 */

import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import type { WsLike, WsLikeCtor } from '#/transcript/ws';
import { HUB_AGENTS_QUERY_KEY, parseAgents, type HubAgentInfo } from './api';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-hub.bearer.';
/** Backoff ceiling for the reconnect loop (base delay doubles up to this). */
const RECONNECT_MAX_DELAY_MS = 5_000;

/** An agent-engine user notification (the `NotifyUser` tool), fanned out by the hub. */
export interface NotifyPayload {
  readonly notificationId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Parse one `/hub/api/stream` frame: the bare, envelope-free
 * `{ type: 'roster', agents }` snapshot OR a `{ type: 'notify', … }` user
 * notification. Anything else — bad JSON, unknown type, missing/malformed
 * fields — reads as "not ours" and returns `undefined` (malformed roster
 * ENTRIES are dropped like the REST reader, without failing the snapshot).
 */
export function parseStreamFrame(
  raw: unknown,
): { readonly type: 'roster'; readonly agents: readonly HubAgentInfo[] } | { readonly type: 'notify'; readonly notify: NotifyPayload } | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as unknown;
  } catch {
    return undefined;
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return undefined;
  const f = frame as Record<string, unknown>;
  if (f['type'] === 'roster') {
    const agents = parseAgents(f['agents']);
    return agents === undefined ? undefined : { type: 'roster', agents };
  }
  if (f['type'] === 'notify') {
    if (
      typeof f['notificationId'] !== 'string' ||
      typeof f['sessionId'] !== 'string' ||
      typeof f['agentId'] !== 'string' ||
      typeof f['agentName'] !== 'string' ||
      typeof f['title'] !== 'string' ||
      typeof f['body'] !== 'string'
    ) {
      return undefined;
    }
    return {
      type: 'notify',
      notify: {
        notificationId: f['notificationId'],
        sessionId: f['sessionId'],
        agentId: f['agentId'],
        agentName: f['agentName'],
        title: f['title'],
        body: f['body'],
      },
    };
  }
  return undefined;
}

/** @deprecated compat alias — use `parseStreamFrame`. */
export function parseRosterFrame(raw: unknown): readonly HubAgentInfo[] | undefined {
  const frame = parseStreamFrame(raw);
  return frame?.type === 'roster' ? frame.agents : undefined;
}

/** Connection lifecycle state surfaced by `useRosterStream`. */
export interface RosterStreamState {
  /** The roster socket is currently open. */
  readonly online: boolean;
  /** Milliseconds since the last roster frame arrived (0 until the first). */
  readonly rosterAge: number;
}

export interface RosterStreamOptions {
  /** Hub origin (`http(s)://…`) — converted to the `/hub/api/stream` ws(s) URL. */
  readonly baseUrl: string;
  readonly token: string;
  readonly queryClient: QueryClient;
  /** State export for the React boundary (fires on open/close/frame). */
  readonly onStateChange?: (state: RosterStreamState) => void;
  /** `notify` frames (agent-engine `NotifyUser` tool), for OS notifications. */
  readonly onNotify?: (notify: NotifyPayload) => void;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff; doubles to a 5s cap. Default `500`. */
  readonly reconnectDelayMs?: number;
}

export class RosterStream {
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly queryClient: QueryClient;
  private readonly onStateChange?: (state: RosterStreamState) => void;
  private readonly onNotify?: (notify: NotifyPayload) => void;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private wsOpen = false;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRosterAt: number | undefined;

  constructor(opts: RosterStreamOptions) {
    this.wsUrl = toRosterStreamUrl(opts.baseUrl);
    this.token = opts.token;
    this.queryClient = opts.queryClient;
    this.onStateChange = opts.onStateChange;
    this.onNotify = opts.onNotify;
    const ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsLikeCtor | undefined);
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WsCtor = ctor;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.connect();
  }

  /** Tear the socket down permanently (unmount path — no reconnect). */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    this.wsOpen = false;
    ws?.close();
  }

  private connect(): void {
    const protocols =
      this.token !== '' ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`] : undefined;
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
      this.wsOpen = true;
      this.emitState();
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      const frame = parseStreamFrame(event.data);
      if (frame === undefined) return;
      if (frame.type === 'notify') {
        this.onNotify?.(frame.notify);
        return;
      }
      this.lastRosterAt = Date.now();
      this.queryClient.setQueryData(HUB_AGENTS_QUERY_KEY, frame.agents);
      this.emitState();
    });
    ws.addEventListener('close', () => {
      // Stale socket (a manual close already cleared `this.ws`).
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.wsOpen = false;
      this.emitState();
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // The 'close' event always follows 'error'; reconnect logic lives there.
    });
  }

  private emitState(): void {
    this.onStateChange?.({
      online: this.wsOpen,
      rosterAge: this.lastRosterAt === undefined ? 0 : Date.now() - this.lastRosterAt,
    });
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    const base = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    // ±20% jitter keeps reconnecting tabs from stampeding the hub together.
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

/**
 * Overlay the live roster stream onto the roster cache. The returned state is
 * event-driven only (updates on socket open/close and per roster frame).
 */
export function useRosterStream(
  queryClient: QueryClient,
  opts: { baseUrl: string; token: string; onNotify?: (notify: NotifyPayload) => void },
): RosterStreamState {
  const { baseUrl, token, onNotify } = opts;
  const [state, setState] = useState<RosterStreamState>({ online: false, rosterAge: 0 });
  const onNotifyRef = useRef(onNotify);
  useEffect(() => {
    onNotifyRef.current = onNotify;
  });
  useEffect(() => {
    const stream = new RosterStream({
      baseUrl,
      token,
      queryClient,
      onStateChange: setState,
      onNotify: (notify) => onNotifyRef.current?.(notify),
    });
    return () => {
      stream.close();
    };
  }, [queryClient, baseUrl, token]);
  return state;
}

/** The `/hub/api/stream` endpoint, derived from the hub origin. */
function toRosterStreamUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for the roster stream: ${base}`);
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/hub/api/stream`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
