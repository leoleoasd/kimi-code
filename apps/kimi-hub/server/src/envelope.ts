/**
 * Hub response envelope — mirrors kap-server's wire shape
 * `packages/kap-server/src/protocol/envelope.ts`: `{ code, msg, data,
 * request_id }` with `code: 0` for success. Duplicated locally on purpose: the
 * hub must stay free of any kap-server dependency.
 */

export interface HubEnvelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
}

/**
 * Hub-local error codes (mirroring kap-server's daemon-reserved numbering;
 * `packages/protocol`'s enum is untouched). The hub web client keys off `40101`
 * for "check the hub token".
 */
export const HUB_ERROR_CODES = {
  /** 401 — missing/invalid hub bearer token. */
  auth: 40101,
  /** 403 — Host header outside the allowlist (mirrors kap-server's 40301). */
  host: 40301,
  /** 403 — the agent is session-scoped and the request falls outside its scope. */
  scope: 40302,
  /** 404 — unknown hub path or unknown agent id. */
  notFound: 40401,
  /** 502 — the tunnel upstream failed (agent fetch failed, oversize, ws open). */
  upstream: 50201,
  /** 504 — the agent did not answer in time. */
  timeout: 50401,
} as const;

export function okEnvelope<T>(data: T, requestId: string): HubEnvelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

export function errEnvelope(code: number, msg: string, requestId: string): HubEnvelope<null> {
  return { code, msg, data: null, request_id: requestId };
}
