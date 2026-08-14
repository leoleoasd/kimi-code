/**
 * The hub's own API: `GET /hub/api/agents` — the roster of currently
 * connected agent machines. The `{ agents: HubAgentInfo[] }` payload rides in
 * the standard envelope `data` field, like every kap-server REST response.
 */

import type { FastifyInstance } from 'fastify';

import type { TunnelRegistry } from '@moonshot-ai/remote-tunnel/hub';

import { okEnvelope } from '#/envelope';

export interface HubApiRouteOptions {
  readonly registry: TunnelRegistry;
}

export function registerHubApiRoutes(app: FastifyInstance, opts: HubApiRouteOptions): void {
  app.get('/hub/api/agents', async (req) => {
    return okEnvelope({ agents: opts.registry.list() }, req.id);
  });
}
