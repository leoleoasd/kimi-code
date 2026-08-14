/**
 * The hub's own API: `GET /hub/api/agents` — the roster of currently
 * connected agent machines; `GET|POST|DELETE /hub/api/push/*` — the Web Push
 * handshake surface (public key + subscription registry). Payloads ride in
 * the standard envelope `data` field, like every kap-server REST response.
 */

import type { FastifyInstance } from 'fastify';

import type { TunnelRegistry } from '@moonshot-ai/remote-tunnel/hub';

import { okEnvelope } from '#/envelope';
import type { PushModule } from '#/push';

export interface HubApiRouteOptions {
  readonly registry: TunnelRegistry;
  readonly push: PushModule;
}

export function registerHubApiRoutes(app: FastifyInstance, opts: HubApiRouteOptions): void {
  app.get('/hub/api/agents', async (req) => {
    return okEnvelope({ agents: opts.registry.list() }, req.id);
  });

  app.get('/hub/api/push/vapid', async (req) => {
    return okEnvelope({ publicKey: opts.push.publicKey }, req.id);
  });

  app.post('/hub/api/push/subscriptions', async (req) => {
    // The proxy's catch-all buffer parser leaves bodies unparsed here.
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    let subscription: { endpoint?: unknown } | undefined;
    try {
      subscription = JSON.parse(raw) as { endpoint?: unknown };
    } catch {
      subscription = undefined;
    }
    if (typeof subscription?.endpoint !== 'string' || subscription.endpoint === '') {
      return okEnvelope({ registered: false, count: opts.push.list().length }, req.id);
    }
    const count = opts.push.upsert(subscription as never as Parameters<PushModule['upsert']>[0]);
    return okEnvelope({ registered: true, count }, req.id);
  });

  app.delete('/hub/api/push/subscriptions', async (req) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    let endpoint: string | undefined;
    try {
      endpoint = (JSON.parse(raw) as { endpoint?: string }).endpoint;
    } catch {
      endpoint = undefined;
    }
    if (typeof endpoint === 'string' && endpoint !== '') {
      return okEnvelope({ removed: true, count: opts.push.remove(endpoint) }, req.id);
    }
    return okEnvelope({ removed: false, count: opts.push.list().length }, req.id);
  });
}
