/**
 * Protocol-transparent per-agent HTTP proxy:
 *
 *   ALL /agents/:agentId/api/v1/*  and  /agents/:agentId/api/v2/*
 *
 * The raw request body is buffered verbatim (a catch-all `*` content-type
 * parser — fastify's JSON parsing must NOT run on these routes — registered in
 * `start.ts`), hop-by-hop headers plus `host` / `authorization` /
 * `content-length` are stripped, and the rest is relayed through the tunnel
 * registry. The upstream response (status + headers + bytes) is relayed
 * verbatim; the agent-side connector strips what the tunnel re-framed and
 * injects the agent-local token.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { MAX_TUNNELED_BODY_BYTES } from '@moonshot-ai/remote-tunnel';
import { TunnelError, type TunnelRegistry } from '@moonshot-ai/remote-tunnel/hub';

import { errEnvelope, HUB_ERROR_CODES } from '#/envelope';
import { decideScopedRequest, filterSessionListBody } from '#/scope';

/** One tunneled body may not exceed the tunnel frame cap, either direction. */
export const PROXY_BODY_LIMIT = MAX_TUNNELED_BODY_BYTES;

/**
 * Must never cross the hub: hop-by-hop/framing headers the tunnel owns, plus
 * the caller's `Authorization` (the connector replaces it with the agent-local
 * token) and `host` (the connector re-targets loopback).
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Invalid after fastify re-frames the upstream body; the connector strips these too. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyRouteOptions {
  readonly registry: TunnelRegistry;
}

type ProxyRequest = FastifyRequest<{ Params: { agentId: string } }>;

export function registerProxyRoutes(app: FastifyInstance, opts: ProxyRouteOptions): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { agentId } = (req as ProxyRequest).params;
    const strippedPath = stripAgentPrefix(req.raw.url ?? '/');
    // Session-scoped agents: gate the request BEFORE it crosses the tunnel
    // (see scope.ts). Unscoped agents (`scope === undefined`) fall through to
    // the plain verbatim relay — the legacy whole-machine behavior.
    const entry = opts.registry.get(agentId);
    const scope = entry?.scope;
    const scopeSet = scope !== undefined ? new Set(scope.sessions) : undefined;
    let filterList = false;
    if (scopeSet !== undefined) {
      const decision = decideScopedRequest(scopeSet, req.method, strippedPath, {
        daemonPid: entry?.pid,
      });
      if (decision.kind === 'deny') {
        return reply
          .code(403)
          .send(
            errEnvelope(HUB_ERROR_CODES.scope, `session-scoped agent: ${decision.reason}`, req.id),
          );
      }
      filterList = decision.kind === 'filter-list';
    }
    try {
      const upstream = await opts.registry.httpRequest(agentId, {
        method: req.method,
        path: strippedPath,
        headers: collectRequestHeaders(req),
        body: rawBody(req.body),
      });
      reply.code(upstream.status);
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
        reply.header(key, value);
      }
      // A filtered list shrinks the body: prefer it (content-length is then
      // dropped and fastify re-frames it); a non-envelope body passes through.
      const body =
        filterList && scopeSet !== undefined
          ? (filterSessionListBody(upstream.body, scopeSet) ?? upstream.body)
          : upstream.body;
      return await reply.send(body);
    } catch (error) {
      return sendTunnelError(reply, req.id, error);
    }
  };

  app.all('/agents/:agentId/api/v1/*', handler);
  app.all('/agents/:agentId/api/v2/*', handler);
}

/**
 * The full upstream path incl. the `/api/v1/...` prefix and query string —
 * taken from the raw URL (after `/agents/<id>`) so encoding survives verbatim,
 * not from the decoded route params.
 */
function stripAgentPrefix(rawUrl: string): string {
  const rest = rawUrl.slice('/agents/'.length);
  const cut = rest.indexOf('/');
  return cut === -1 ? '/' : rest.slice(cut);
}

/** The `*` parser hands Buffers; a slipped-through string is re-encoded utf8. */
function rawBody(body: unknown): Buffer | undefined {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === 'string' && body.length > 0) {
    return Buffer.from(body, 'utf8');
  }
  return undefined;
}

function collectRequestHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function sendTunnelError(reply: FastifyReply, requestId: string, error: unknown): FastifyReply {
  if (error instanceof TunnelError) {
    switch (error.code) {
      case 'agent_not_found':
        return reply.code(404).send(errEnvelope(HUB_ERROR_CODES.notFound, error.message, requestId));
      case 'timeout':
        return reply.code(504).send(errEnvelope(HUB_ERROR_CODES.timeout, error.message, requestId));
      case 'agent_disconnected':
      case 'oversize_body':
      case 'ws_open_failed':
        // The tunnel upstream is at fault, not the caller.
        return reply.code(502).send(errEnvelope(HUB_ERROR_CODES.upstream, error.message, requestId));
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return reply
    .code(502)
    .send(errEnvelope(HUB_ERROR_CODES.upstream, `agent proxy failure: ${message}`, requestId));
}
