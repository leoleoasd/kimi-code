/**
 * Session-scope enforcement ("session-scoped agent" — Claude Code style 1:1
 * session bridge).
 *
 * A connector may declare `scope: { sessions: [...] }` in its tunnel hello
 * (`kimi remote connect --session <id>` always does). The hub then exposes
 * ONLY those sessions through the agent's `/agents/:agentId` surface:
 *
 *   REST (path evaluated after the `/agents/:agentId` prefix is stripped):
 *   - always allowed: `GET /api/v1/healthz`, `GET /api/v1/meta`,
 *     `GET /api/v1/auth` (bootstrap agents/UI need them),
 *     `GET /api/v1/models` (the configured catalog — alias/display names only,
 *     no credentials; the prompt surface already accepts any of these via its
 *     `model` field, so the hub UI's model picker needs the same list);
 *   - `GET /api/v1/mcp/oauth/callback` (the OAuth browser redirect target —
 *     state-keyed, no session affiliation; see auth.ts for the token-free
 *     rationale);
 *   - `/api/v1/files[/{id}]` (upload/GET/DELETE): the prompt-attachment
 *     store — required for image sending from the hub UI; file ids are
 *     unguessable, and prompt bodies stay session-checked;
 *   - `/{v1|v2}/sessions/{sid}/...` (any subpath, any method): allowed iff
 *     `sid` is in scope;
 *   - `GET /api/v1/sessions` + `GET /api/v2/sessions`: forwarded, and the
 *     successful JSON envelope body is filtered so every `data.*` array of
 *     session objects keeps only entries whose `id` is in scope
 *     (a non-envelope body passes through unchanged);
 *   - everything else (session create, host surfaces, …): 403.
 *
 *   WS (`/agents/:agentId/api/v1/ws`, kap-server control frames from
 *   `packages/kap-server/src/protocol/ws-control.ts`):
 *   - browser → hub: `subscribe` is rewritten to `session_ids ∩ S` and
 *     dropped when empty (`cursors` / `watch_fs` / `agent_filter` — all keyed
 *     by session id — are filtered likewise); `subscribe_v2` /
 *     `unsubscribe_v2` are dropped when their `session_id` is out of scope;
 *   - hub → browser: any JSON text frame carrying a top-level `session_id`
 *     outside the scope is dropped; frames without one pass (`transcript.*`
 *     frames only ever flow for filtered subscriptions).
 *
 * Agents that connect WITHOUT a scope skip all of this: full proxy, the
 * legacy whole-machine behavior.
 *
 * Denied REST requests carry `40302 session-scoped agent: <reason>` in the
 * standard `{code, msg, data, request_id}` envelope (see `envelope.ts`).
 */

/** Paths that stay reachable on a scoped agent (GET only, exact match). */
const ALWAYS_ALLOWED_GET_PATHS = new Set([
  '/api/v1/healthz',
  '/api/v1/meta',
  '/api/v1/auth',
  '/api/v1/models',
  '/api/v1/mcp/oauth/callback',
]);

/** `/api/v1/files[/{id}]` — any method: up/download/delete prompt attachments. */
const FILES_PATH_PATTERN = /^\/api\/v1\/files(?:\/[^/]+)?$/;

/**
 * `/api/{v1|v2}/sessions/<sid>[/subpath...]` — the first segment after
 * `sessions` is the session id, which kap-server ALSO suffixes with
 * `:action` for its action routes (`<sid>:abort`, `<sid>:compact`, …, see
 * `packages/kap-server/src/routes/action-suffix.ts`). Deep colon-suffixed
 * routes (`…/prompts/{id}:abort`, `…/skills/{name}:activate`) don't matter:
 * only slot 1 identifies the session.
 */
const SESSION_PATH_PATTERN = /^\/api\/(?:v1|v2)\/sessions\/([^/:]+)(?::[a-z_]+)?/;

/** The two session-list endpoints (query string already stripped by callers). */
const SESSION_LIST_PATHS = new Set(['/api/v1/sessions', '/api/v2/sessions']);

/**
 * kap-server client→server frames intercepted by name: `subscribe` carries a
 * `session_ids` array (+ session-keyed `cursors` / `watch_fs` / `agent_filter`
 * records), `subscribe_v2` / `unsubscribe_v2` carry a single `session_id`.
 */
const SUBSCRIBE = 'subscribe';
const SUBSCRIBE_V2 = 'subscribe_v2';
const UNSUBSCRIBE_V2 = 'unsubscribe_v2';

/** Session-keyed records inside a `subscribe` payload. */
const SUBSCRIBE_SESSION_RECORD_KEYS = ['cursors', 'watch_fs', 'agent_filter'] as const;

export type ScopedDecision =
  | { readonly kind: 'forward' }
  | { readonly kind: 'filter-list' }
  | { readonly kind: 'deny'; readonly reason: string };

/**
 * Where `rawPath` fits a scoped agent's REST policy. `rawPath` is the path
 * AFTER the `/agents/:agentId` prefix (query string allowed); the session id
 * is compared as the raw URL segment — session ids are URL-safe, anything
 * encoded simply never matches (deny-by-default).
 */
export function decideScopedRequest(
  scope: ReadonlySet<string>,
  method: string,
  rawPath: string,
): ScopedDecision {
  const q = rawPath.indexOf('?');
  const pathname = q === -1 ? rawPath : rawPath.slice(0, q);
  const upperMethod = method.toUpperCase();

  if (upperMethod === 'GET' && ALWAYS_ALLOWED_GET_PATHS.has(pathname)) {
    return { kind: 'forward' };
  }

  const sessionMatch = SESSION_PATH_PATTERN.exec(pathname);
  if (sessionMatch !== null) {
    const sessionId = sessionMatch[1]!;
    if (scope.has(sessionId)) return { kind: 'forward' };
    return { kind: 'deny', reason: `session ${sessionId} is outside this agent's scope` };
  }

  if (FILES_PATH_PATTERN.test(pathname)) {
    return { kind: 'forward' };
  }

  if (upperMethod === 'GET' && SESSION_LIST_PATHS.has(pathname)) {
    return { kind: 'filter-list' };
  }

  return { kind: 'deny', reason: `${upperMethod} ${pathname} is not exposed by this agent` };
}

/**
 * Filter a tunneled session-list response: parse the body as a successful
 * kap-server envelope `{code: 0, data: {...}}` and drop, from every `data.*`
 * array of session objects (every element an object with a string `id`), the
 * entries whose `id` is out of scope. Returns `undefined` when the body is
 * not such an envelope — callers relay it unchanged.
 */
export function filterSessionListBody(body: Buffer, scope: ReadonlySet<string>): Buffer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || parsed['code'] !== 0) return undefined;
  const data = parsed['data'];
  if (!isPlainObject(data)) return undefined;
  let touched = false;
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value) || !value.every(isSessionLike)) continue;
    const kept = value.filter((item) => isSessionLike(item) && scope.has(item.id));
    if (kept.length === value.length) continue;
    data[key] = kept;
    touched = true;
  }
  if (!touched) return undefined;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

/**
 * Rewrite a browser → hub text frame under a session scope. Returns the
 * (possibly rewritten) frame to forward, or `undefined` to drop it. Only the
 * subscription frames are inspected; everything else (and anything that
 * does not parse as a JSON object) passes through unchanged — a scoped agent
 * never produces out-of-scope traffic for the other frame types on its own.
 */
export function filterClientWsFrame(frame: string, scope: ReadonlySet<string>): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return frame;
  }
  if (!isPlainObject(parsed)) return frame;

  if (parsed['type'] === SUBSCRIBE) {
    const payload = parsed['payload'];
    if (!isPlainObject(payload) || !Array.isArray(payload['session_ids'])) return frame;
    const sessionIds = payload['session_ids'].filter(
      (id): id is string => typeof id === 'string' && scope.has(id),
    );
    if (sessionIds.length === 0) return undefined;
    payload['session_ids'] = sessionIds;
    for (const key of SUBSCRIBE_SESSION_RECORD_KEYS) {
      const record = payload[key];
      if (!isPlainObject(record)) continue;
      payload[key] = Object.fromEntries(Object.entries(record).filter(([id]) => scope.has(id)));
    }
    return JSON.stringify(parsed);
  }

  if (parsed['type'] === SUBSCRIBE_V2 || parsed['type'] === UNSUBSCRIBE_V2) {
    const payload = parsed['payload'];
    if (!isPlainObject(payload) || typeof payload['session_id'] !== 'string') return frame;
    return scope.has(payload['session_id']) ? frame : undefined;
  }

  return frame;
}

/**
 * Whether a hub → browser text frame may pass under a session scope: any JSON
 * object frame carrying a top-level `session_id` outside the scope is dropped
 * (that includes out-of-scope global fan-in events); frames that fail to
 * parse or carry no `session_id` pass.
 */
export function passServerWsFrame(frame: string, scope: ReadonlySet<string>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return true;
  }
  if (!isPlainObject(parsed)) return true;
  const sessionId = parsed['session_id'];
  return typeof sessionId !== 'string' || scope.has(sessionId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A session-list entry: a plain object keyed by a string `id`. */
function isSessionLike(value: unknown): value is { id: string } {
  return isPlainObject(value) && typeof value['id'] === 'string';
}
