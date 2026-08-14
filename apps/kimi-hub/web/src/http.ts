/**
 * Shared REST plumbing for the hub + kap-server envelope contract: every
 * response is `{ code, msg, data, request_id }` with the business outcome in
 * `code` (`0` = success) while the HTTP status only reports transport-level
 * outcomes (the one exception is hub auth, which short-circuits with HTTP
 * 401). A non-zero code is a business error — except a few endpoints that
 * intentionally report a benign outcome with a dedicated code (the question
 * `:dismiss` endpoint replies `40909` on success); callers accept those via
 * `acceptCodes`.
 *
 * All helpers take the base URL and token explicitly (never read globals) —
 * the same module serves the hub API and every per-agent proxy base.
 */

export interface HttpEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export class EnvelopeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`${message} (code ${code})`);
    this.name = 'EnvelopeError';
  }
}

function authHeaders(token: string): Record<string, string> {
  return token === '' ? {} : { authorization: `Bearer ${token}` };
}

function unwrapEnvelope(body: unknown, status: number, acceptCodes: readonly number[]): unknown {
  const envelope = (
    body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
  ) as Record<string, unknown>;
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : undefined;
  const msg = typeof envelope['msg'] === 'string' ? envelope['msg'] : '';
  if (code === undefined) {
    throw new Error(`unexpected response shape (http ${status})`);
  }
  if (!acceptCodes.includes(code)) {
    throw new EnvelopeError(code, msg === '' ? `request failed` : msg);
  }
  return envelope['data'];
}

function checkHttpOk(res: Response): void {
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if (!res.ok) {
    throw new Error(`http ${res.status} ${res.statusText}`);
  }
}

export async function getJson(
  endpoint: HttpEndpoint & { path: string; query?: URLSearchParams; acceptCodes?: readonly number[] },
): Promise<unknown> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const query = endpoint.query?.toString() ?? '';
  const res = await doFetch(`${endpoint.baseUrl}${endpoint.path}${query === '' ? '' : `?${query}`}`, {
    headers: authHeaders(endpoint.token),
  });
  checkHttpOk(res);
  const body: unknown = await res.json();
  return unwrapEnvelope(body, res.status, endpoint.acceptCodes ?? [0]);
}

export async function postJson(
  endpoint: HttpEndpoint & { path: string; body?: unknown; acceptCodes?: readonly number[] },
): Promise<unknown> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const res = await doFetch(`${endpoint.baseUrl}${endpoint.path}`, {
    method: 'POST',
    headers: { ...authHeaders(endpoint.token), 'content-type': 'application/json' },
    body: JSON.stringify(endpoint.body ?? {}),
  });
  checkHttpOk(res);
  const body: unknown = await res.json();
  return unwrapEnvelope(body, res.status, endpoint.acceptCodes ?? [0]);
}
