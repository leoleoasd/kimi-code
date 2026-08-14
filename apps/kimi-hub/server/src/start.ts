/**
 * `startHub` — boot the hub: tunnel registry, auth + host hooks, hub API,
 * per-agent proxy, WS upgrade handling, static web UI, listen with port+1
 * retry (mirroring kap-server's `listenWithPortRetry`, capped at 20).
 */

import Fastify from 'fastify';

import { createTunnelRegistry, type TunnelRegistry } from '@moonshot-ai/remote-tunnel/hub';

import { createHubAuthHook } from '#/auth';
import { resolveHubConfig, type HubCliArgs, type HubConfig } from '#/config';
import { errEnvelope, HUB_ERROR_CODES } from '#/envelope';
import { formatHostErrorMessage, isAllowedHost, parseAllowedHosts } from '#/hostnames';
import { openPushModule } from '#/push';
import { registerHubApiRoutes } from '#/routes/hubApi';
import { PROXY_BODY_LIMIT, registerProxyRoutes } from '#/routes/proxy';
import { createWebAssetStore, registerWebAssetRoutes } from '#/routes/webAssets';
import { registerUpgradeHandling } from '#/ws';

export interface StartHubOptions {
  readonly host?: string;
  readonly port?: number | string;
  readonly token?: string;
  readonly webDist?: string;
  readonly logLevel?: string;
  /** Mirrors `kimi web`'s `--dangerous-bypass-auth` (kap-server's `disableAuth`). */
  readonly dangerousBypassAuth?: boolean;
  /** Defaults to `process.env` (token fallback, allowed-hosts list). */
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunningHub {
  readonly origin: string;
  readonly host: string;
  /** Actually-bound port (after ephemeral assignment / port+1 retry). */
  readonly port: number;
  readonly token: string;
  readonly tokenGenerated: boolean;
  /** True when started with `--dangerous-bypass-auth` (auth checks skipped). */
  readonly dangerousBypassAuth: boolean;
  readonly warnings: readonly string[];
  readonly registry: TunnelRegistry;
  close(): Promise<void>;
}

export const HUB_PORT_RETRY_LIMIT = 20;

export async function startHub(opts: StartHubOptions = {}): Promise<RunningHub> {
  const env = opts.env ?? process.env;
  const cliArgs: HubCliArgs = {
    host: opts.host,
    port: opts.port,
    token: opts.token,
    webDist: opts.webDist,
    logLevel: opts.logLevel,
    dangerousBypassAuth: opts.dangerousBypassAuth,
  };
  const config = resolveHubConfig({ cliArgs, env });

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    disableRequestLogging: true,
    bodyLimit: PROXY_BODY_LIMIT,
  });
  // `--dangerous-bypass-auth` lifts the token requirement on BOTH ends of the
  // wire: the HTTP auth hook + browser-facing WS checks below, and the
  // registry's hello handshake (trustAnyToken skips the bearer subprotocol and
  // `hello.token` validation; the protocol version check stays). Connectors
  // presenting the banner token still work — any token value passes.
  const registry = createTunnelRegistry({ token: config.token, trustAnyToken: config.disableAuth });
  const allowlist = { boundHost: config.host, extra: parseAllowedHosts(env) };
  const isHostAllowed = (host: string | undefined): boolean => isAllowedHost(host, allowlist);

  // DNS-rebinding defence on HTTP as well (WS has its own in `ws.ts`),
  // before auth — matching kap-server's hook order.
  app.addHook('onRequest', async (req, reply) => {
    if (!isHostAllowed(req.headers.host)) {
      return reply
        .code(403)
        .send(errEnvelope(HUB_ERROR_CODES.host, formatHostErrorMessage(req.headers.host), req.id));
    }
  });
  app.addHook('onRequest', createHubAuthHook({ token: config.token, disableAuth: config.disableAuth }));

  // Buffer request bodies verbatim for the proxy routes: fastify's JSON/text
  // parsing must never run on tunneled traffic. The '*' catch-all does NOT
  // shadow fastify's built-in `application/json` and `text/plain` parsers, so
  // those two are overridden explicitly as well.
  const bufferParser = (
    _req: unknown,
    body: string | Buffer,
    done: (err: Error | null, result?: unknown) => void,
  ): void => {
    done(null, body);
  };
  for (const contentType of ['*', 'application/json', 'text/plain']) {
    app.addContentTypeParser(contentType, { parseAs: 'buffer', bodyLimit: PROXY_BODY_LIMIT }, bufferParser);
  }

  const push = await openPushModule(config.dataDir);
  registerHubApiRoutes(app, { registry, push });
  registerProxyRoutes(app, { registry });

  // Unknown paths outside the GET surface (e.g. POST /hub/typo): reserved
  // prefixes answer with the 40401 envelope, matching the webAsset routes.
  app.setNotFoundHandler(async (req, reply) => {
    return reply.code(404).send(errEnvelope(HUB_ERROR_CODES.notFound, 'not found', req.id));
  });

  const upgrades = registerUpgradeHandling(app, {
    registry,
    token: config.token,
    isHostAllowed,
    disableAuth: config.disableAuth,
    push,
  });
  await registerWebAssetRoutes(app, createWebAssetStore(config));

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Terminate upgraded sockets first: node/http never closes them, and an
    // open agent tunnel would otherwise keep `app.close()` pending.
    upgrades.closeAll();
    app.server.closeAllConnections();
    await app.close();
  };

  try {
    await listenWithPortRetry({
      listen: async (host, port) => app.listen({ host, port }),
      host: config.host,
      port: config.port,
      logger: app.log,
      maxRetries: HUB_PORT_RETRY_LIMIT,
    });
  } catch (error) {
    await close();
    throw error;
  }

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : config.port;

  return {
    origin: formatOrigin(config.host, boundPort),
    host: config.host,
    port: boundPort,
    token: config.token,
    tokenGenerated: config.tokenGenerated,
    dangerousBypassAuth: config.disableAuth,
    warnings: config.warnings,
    registry,
    close,
  };
}

function formatOrigin(host: string, port: number): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

interface ListenWithPortRetryOptions {
  readonly listen: (host: string, port: number) => Promise<string>;
  readonly host: string;
  readonly port: number;
  readonly logger: { warn: (obj: unknown, msg?: string) => void };
  readonly maxRetries?: number;
}

/**
 * Bind, retrying with `port + 1` when the port is held — mirrors kap-server's
 * `listenWithPortRetry`. Port 0 (OS-assigned ephemeral) is never retried.
 */
async function listenWithPortRetry(opts: ListenWithPortRetryOptions): Promise<void> {
  if (opts.port === 0) {
    await opts.listen(opts.host, 0);
    return;
  }
  const maxRetries = opts.maxRetries ?? HUB_PORT_RETRY_LIMIT;
  let port = opts.port;
  for (let attempt = 0; ; attempt++) {
    try {
      await opts.listen(opts.host, port);
      if (port !== opts.port) {
        opts.logger.warn(
          { requestedPort: opts.port, port, host: opts.host },
          'requested port was busy; bound to a higher port',
        );
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || attempt >= maxRetries || port >= 65535) {
        throw error;
      }
      opts.logger.warn({ host: opts.host, port, next: port + 1 }, 'port busy, trying next port');
      port += 1;
    }
  }
}

export type { HubConfig } from '#/config';
export { resolveHubConfig } from '#/config';
