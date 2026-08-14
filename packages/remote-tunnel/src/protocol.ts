/**
 * Reverse-tunnel wire protocol between the hub (`@moonshot-ai/kimi-hub-server`)
 * and outbound-connected agent connectors (`kimi remote connect`).
 *
 * One WebSocket per agent connection multiplexes:
 *  - any number of HTTP request/response round trips (keyed by `id`), and
 *  - any number of virtual WebSocket relays (keyed by `id`).
 *
 * All frames are JSON text frames. Binary payloads ride base64 in `bodyB64` /
 * `dataB64` fields so frames stay valid JSON text.
 *
 * Flow: the *agent connector* dials out to the hub (`TUNNEL_PATH`), so agents
 * behind NAT/firewalls never need to listen on a reachable port. The hub
 * authenticates the connection either via the WebSocket subprotocol
 * (`TUNNEL_BEARER_PROTOCOL_PREFIX + token`, the only credential channel usable
 * from browser WebSockets) or via the first frame (`hello.token`).
 */

import { z } from 'zod';

export const TUNNEL_PROTOCOL_VERSION = 1;

/** `Sec-WebSocket-Protocol` prefix carrying the hub credential. */
export const TUNNEL_BEARER_PROTOCOL_PREFIX = 'kimi-hub.bearer.';

/** Path the hub exposes for agent tunnel connections (WebSocket upgrade). */
export const TUNNEL_PATH = '/internal/tunnel';

/** Cap on one tunneled HTTP body (either direction); oversize → 502/413. */
export const MAX_TUNNELED_BODY_BYTES = 32 * 1024 * 1024;

/** Hub-side WS ping interval; connection dropped after ~2 silent cycles. */
export const TUNNEL_HEARTBEAT_MS = 15_000;

export const agentInfoSchema = z.object({
  /** Human label shown in the hub UI (defaults to hostname client-side). */
  name: z.string().min(1),
  platform: z.string(),
  arch: z.string(),
  /** kimi-code version of the connector, for display. */
  version: z.string().optional(),
  cwd: z.string().optional(),
  pid: z.number().int().optional(),
  /**
   * The sessions this connection exposes on the hub ("session-scoped"
   * agent — the hub only relays those sessions' REST/WS traffic). Absent
   * means the legacy whole-machine behavior: everything is relayed.
   */
  scope: z
    .object({
      sessions: z.array(z.string()).min(1),
    })
    .optional(),
});
export type AgentInfo = z.infer<typeof agentInfoSchema>;

/* ---------------------------------- hello ---------------------------------- */

/** connector → hub: first frame on every (re)connect. */
export const helloFrameSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  /**
   * Connectors always send it. Optional on parse so a `trustAnyToken` hub can
   * accept a tokenless hello; a strict hub rejects the mismatch as
   * `invalid token` (same close code as before).
   */
  token: z.string().optional(),
  agent: agentInfoSchema,
});
export type HelloFrame = z.infer<typeof helloFrameSchema>;

/** hub → connector: registration succeeded; `agentId` is per connection. */
export const helloAckFrameSchema = z.object({
  type: z.literal('hello.ack'),
  agentId: z.string(),
  heartbeatMs: z.number().int(),
});
export type HelloAckFrame = z.infer<typeof helloAckFrameSchema>;

/** hub → connector: auth/version failure; hub closes the socket right after. */
export const helloRejectFrameSchema = z.object({
  type: z.literal('hello.reject'),
  reason: z.string(),
});
export type HelloRejectFrame = z.infer<typeof helloRejectFrameSchema>;

/* ---------------------------------- scope ---------------------------------- */

/**
 * connector → hub: replace the connection's session scope in place ("scope
 * follow" — e.g. an attach-mode TUI bridging every session it opens, not just
 * the one current at connect time). Unlike the hello, the array may be empty;
 * the hub swaps `info.scope` wholesale, so an empty set scopes the agent to
 * nothing until the next update.
 */
export const scopeUpdateFrameSchema = z.object({
  type: z.literal('scope.update'),
  sessions: z.array(z.string()),
});
export type ScopeUpdateFrame = z.infer<typeof scopeUpdateFrameSchema>;

/* ---------------------------------- notify --------------------------------- */

/**
 * connector → hub: an out-of-band USER notification from the agent engine
 * (its `NotifyUser` tool publishes `event.user.notify`; the connector's
 * kap-server wiring lifts it here). The hub fans it out on its own roster
 * stream so open hub-web pages can raise an OS-level notification even for a
 * session with no chat open. `notificationId` dedupes retries/echoes
 * (Web Notification `tag` semantics).
 */
export const notifyFrameSchema = z.object({
  type: z.literal('notify'),
  notificationId: z.string(),
  sessionId: z.string(),
  agentId: z.string().optional(),
  title: z.string(),
  body: z.string(),
});
export type NotifyFrame = z.infer<typeof notifyFrameSchema>;

/* ---------------------------------- http ----------------------------------- */

/** hub → connector: perform this request against the agent's local server. */
export const httpRequestFrameSchema = z.object({
  type: z.literal('http.req'),
  id: z.string(),
  method: z.string(),
  /** Full path incl. `/api/v1/...` prefix and query string. */
  path: z.string(),
  headers: z.record(z.string(), z.string()),
  bodyB64: z.string().optional(),
});
export type HttpRequestFrame = z.infer<typeof httpRequestFrameSchema>;

/** hub → connector: abort an in-flight request (client went away). */
export const httpAbortFrameSchema = z.object({
  type: z.literal('http.abort'),
  id: z.string(),
});
export type HttpAbortFrame = z.infer<typeof httpAbortFrameSchema>;

/** connector → hub: response for `id`. */
export const httpResponseFrameSchema = z.object({
  type: z.literal('http.res'),
  id: z.string(),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  bodyB64: z.string().optional(),
});
export type HttpResponseFrame = z.infer<typeof httpResponseFrameSchema>;

/* ------------------------------ ws virtual relay --------------------------- */

/** hub → connector: open a WebSocket to the agent's local server. */
export const wsOpenFrameSchema = z.object({
  type: z.literal('ws.open'),
  id: z.string(),
  /** Path incl. query, e.g. `/api/v1/ws`. */
  path: z.string(),
});
export type WsOpenFrame = z.infer<typeof wsOpenFrameSchema>;

/** connector → hub: local socket connected and ready to relay. */
export const wsOpenedFrameSchema = z.object({
  type: z.literal('ws.opened'),
  id: z.string(),
});
export type WsOpenedFrame = z.infer<typeof wsOpenedFrameSchema>;

/** connector → hub: local socket failed to open; hub closes the UI socket. */
export const wsErrorFrameSchema = z.object({
  type: z.literal('ws.error'),
  id: z.string(),
  message: z.string(),
});
export type WsErrorFrame = z.infer<typeof wsErrorFrameSchema>;

/** both directions: payload for the relay. */
export const wsMessageFrameSchema = z.object({
  type: z.literal('ws.msg'),
  id: z.string(),
  dataB64: z.string(),
  /** True when the payload is a binary frame (default: text). */
  binary: z.boolean().optional(),
});
export type WsMessageFrame = z.infer<typeof wsMessageFrameSchema>;

/** both directions: close the relay (mirrored to the other side). */
export const wsCloseFrameSchema = z.object({
  type: z.literal('ws.close'),
  id: z.string(),
  code: z.number().int().optional(),
  reason: z.string().optional(),
});
export type WsCloseFrame = z.infer<typeof wsCloseFrameSchema>;

/* --------------------------------- unions ---------------------------------- */

/** Every frame the connector is allowed to send. */
export const connectorFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  scopeUpdateFrameSchema,
  notifyFrameSchema,
  httpResponseFrameSchema,
  wsOpenedFrameSchema,
  wsErrorFrameSchema,
  wsMessageFrameSchema,
  wsCloseFrameSchema,
]);
export type ConnectorFrame = z.infer<typeof connectorFrameSchema>;

/** Every frame the hub is allowed to send. */
export const hubFrameSchema = z.discriminatedUnion('type', [
  helloAckFrameSchema,
  helloRejectFrameSchema,
  httpRequestFrameSchema,
  httpAbortFrameSchema,
  wsOpenFrameSchema,
  wsMessageFrameSchema,
  wsCloseFrameSchema,
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

export function encodeFrame(frame: ConnectorFrame | HubFrame): string {
  return JSON.stringify(frame);
}

/** Parse a frame received by the hub; `undefined` when not a connector frame. */
export function parseConnectorFrame(data: string): ConnectorFrame | undefined {
  try {
    return connectorFrameSchema.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

/** Parse a frame received by the connector; `undefined` when not a hub frame. */
export function parseHubFrame(data: string): HubFrame | undefined {
  try {
    return hubFrameSchema.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function encodeB64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

export function decodeB64(data: string): Buffer {
  return Buffer.from(data, 'base64');
}
