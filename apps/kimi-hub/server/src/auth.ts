/**
 * Bearer-auth `onRequest` hook.
 *
 * Exactly like kap-server, the UI shell loads token-free: everything outside
 * the reserved `/hub`, `/agents`, `/internal` prefixes is exempt (any method —
 * kap-server's hook bypasses non-API paths the same way). Reserved paths
 * require `Authorization: Bearer <hub token>` (timing-safe compare); failures
 * get HTTP 401 + the `{ code: 40101 }` envelope the web client keys off.
 */

import { timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope, HUB_ERROR_CODES } from '#/envelope';

/** Path prefixes that always require the hub bearer token. */
const RESERVED_PREFIXES = ['/hub', '/agents', '/internal'] as const;

/**
 * The MCP OAuth browser callback: the provider 302s a top-level GET here
 * (no bearer header possible), the hub proxies it down the tunnel, and the
 * agent matches it to a pending flow by the high-entropy `state` param —
 * the state itself is the capability, so this one path stays token-free.
 */
const MCP_OAUTH_CALLBACK_PATH = /^\/agents\/[^/]+\/api\/v1\/mcp\/oauth\/callback$/;

export function isReservedPath(path: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function hasValidBearer(authorization: string | undefined, token: string): boolean {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return false;
  }
  return safeTokenEqual(authorization.slice('Bearer '.length), token);
}

/** Length-mismatched tokens short-circuit — this leaks the token length at most. */
export function safeTokenEqual(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHubAuthHook(opts: {
  token: string;
  /** `--dangerous-bypass-auth`: reserved paths skip the bearer gate entirely. */
  disableAuth?: boolean;
}): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
  return async (req, reply) => {
    if (opts.disableAuth === true) {
      return;
    }
    const path = requestPath(req.raw.url);
    if (req.method === 'GET' && MCP_OAUTH_CALLBACK_PATH.test(path)) {
      return;
    }
    if (!isReservedPath(path)) {
      return;
    }
    if (hasValidBearer(req.headers.authorization, opts.token)) {
      return;
    }
    return reply
      .code(401)
      .send(
        errEnvelope(HUB_ERROR_CODES.auth, 'unauthorized: a valid hub bearer token is required', req.id),
      );
  };
}

function requestPath(rawUrl: string | undefined): string {
  if (rawUrl === undefined) {
    return '/';
  }
  const query = rawUrl.indexOf('?');
  return query === -1 ? rawUrl : rawUrl.slice(0, query);
}
