/**
 * Kap server boot tests — exercise the public server lifecycle, App-scope
 * seeds, instance registration, loopback routes, and owned resource cleanup
 * with real local storage and loopback sockets.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
  bootstrap,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  drainSessionMetadataWrites,
  getLiveSessionById,
  IAgentLifecycleService,
  IBootstrapService,
  IEventBus,
  IFileSystemStorageService,
  IHostRequestHeaders,
  InMemoryStorageService,
  IOAuthToolkit,
  ISessionIndexMirror,
  ISessionLifecycleService,
  ITelemetryService,
  IWorkspaceLifecycleService,
  logSeed,
  noopTelemetryService,
  resolveLoggingConfig,
  type DomainEvent,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { drainGlobalSearchDisposals } from '../src/search/searchService';
import { listenWithPortRetry, type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch, authHeaders } from './helpers/auth';

describe('server-v2 boot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('boots agent-core-v2 and serves the basic /api/v1 routes', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    const base = `http://127.0.0.1:${server.port}`;

    const healthz = await fetch(`${base}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
    const healthBody = await healthz.json() as {
      code: number;
      data: { ok: boolean };
      request_id: string;
    };
    expect(healthBody.code).toBe(0);
    expect(healthBody.data.ok).toBe(true);
    expect(typeof healthBody.request_id).toBe('string');

    const meta = await authedFetch(server, base, '/api/v1/meta');
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as {
      code: number;
      data: { server_id: string; server_version: string; capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(typeof metaBody.data.server_id).toBe('string');
    expect(typeof metaBody.data.server_version).toBe('string');
    expect(metaBody.data.capabilities).toBeDefined();

    const auth = await authedFetch(server, base, '/api/v1/auth');
    expect(auth.status).toBe(200);
    const authBody = await auth.json() as {
      code: number;
      data: { ready: boolean; providers_count: number; default_model: string | null };
    };
    expect(authBody.code).toBe(0);
    expect(typeof authBody.data.ready).toBe('boolean');
    expect(authBody.data.providers_count).toBeGreaterThanOrEqual(0);

    // Poll with no flow in flight → null payload; exercises the v2 IOAuthService
    // wiring without starting a real (networked) device-code flow.
    const oauthPoll = await authedFetch(server, base, '/api/v1/oauth/login');
    expect(oauthPoll.status).toBe(200);
    const oauthBody = await oauthPoll.json() as { code: number; data: null };
    expect(oauthBody.code).toBe(0);
    expect(oauthBody.data).toBeNull();
  });

  it('reports opts.serverVersion as server_version instead of the package version', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-version-'));
    server = await startServer({
      hostIdentity: {
        productName: 'test-host',
        version: '9.9.9-host',
        platform: 'test_platform',
      },
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      serverVersion: '9.9.9-host',
    });

    const base = `http://127.0.0.1:${server.port}`;
    const meta = await authedFetch(server, base, '/api/v1/meta');
    const metaBody = await meta.json() as {
      code: number;
      data: { server_version: string };
    };
    expect(metaBody.data.server_version).toBe('9.9.9-host');

    // The engine version is also what the instance registry advertises to
    // status/ps clients.
    const [instance] = await listLiveServerInstances(home);
    expect(instance?.serverVersion).toBe('9.9.9-host');

    // ... while the default product User-Agent and the engine's client
    // identity come from the host identity.
    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/9.9.9-host');
    expect(server.core.accessor.get(IBootstrapService).clientIdentity).toEqual({
      productName: 'test-host',
      version: '9.9.9-host',
      platform: 'test_platform',
    });
  });

  it('seeds default Kimi identity headers from hostIdentity that opts.seeds can override', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ua-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const defaults = server.core.accessor.get(IHostRequestHeaders);
    expect(defaults.headers['User-Agent']).toBe('test-host/0.0.0-test');
    expect(defaults.headers['X-Msh-Version']).toBe('0.0.0-test');
    expect(defaults.headers['X-Msh-Platform']).toBe('test_platform');

    // Restart on the same homeDir with a host-provided seed; it must win over
    // the default (a host can always re-seed the port with its own instance).
    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IHostRequestHeaders, { headers: { 'User-Agent': 'custom-host/9.9' } }]],
    });
    const overridden = server.core.accessor.get(IHostRequestHeaders);
    expect(overridden.headers['User-Agent']).toBe('custom-host/9.9');
  });

  it('seeds explicit skill dirs into the core scope when skillDirs is provided', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-skills-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      skillDirs: ['/skills/explicit'],
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toEqual([
      '/skills/explicit',
    ]);

    // Without skillDirs the resolved args carry no explicit dirs.
    await server.close();
    server = undefined;
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    expect(server.core.accessor.get(IBootstrapService).args.skillDirs).toBeUndefined();
  });

  it('does not shut down a host-injected telemetry service when server telemetry is disabled', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-host-telemetry-'));
    await writeFile(join(home, 'config.toml'), 'telemetry = false\n', 'utf8');
    const shutdown = vi.fn(async () => {});

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[ITelemetryService, { ...noopTelemetryService, shutdown }]],
    });

    await server.close();
    server = undefined;

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('completes server cleanup when owned telemetry shutdown fails', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-telemetry-failure-'));
    const storage = new InMemoryStorageService();
    const write = storage.write.bind(storage);
    vi.spyOn(storage, 'write').mockImplementation(async (scope, key, data, options) => {
      if (scope === 'telemetry') throw new Error('telemetry storage unavailable');
      await write(scope, key, data, options);
    });
    const auth = {
      _serviceBrand: undefined,
      getCachedAccessToken: async () => {
        throw new Error('telemetry auth unavailable');
      },
    } as unknown as IOAuthToolkit;

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      telemetry: true,
      seeds: [
        [IFileSystemStorageService, storage],
        [IOAuthToolkit, auth],
      ],
    });
    const core = server.core;
    core.accessor.get(ITelemetryService).track('server_probe');

    await server.close();
    server = undefined;

    expect(() => core.accessor.get(IBootstrapService)).toThrow();
    expect(await listLiveServerInstances(home)).toEqual([]);
  });
});

/**
 * `startServer({ core })` — the injection seam for hosts that already own a
 * bootstrapped App scope (the TUI's `/remote connect`): the server must serve
 * THAT live engine and leave its teardown to the host.
 */
describe('server-v2 injected core', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let scope: Scope | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (scope !== undefined) {
      // The host (this test) owns the scope: run the same engine teardown the
      // owned-core server close() would have.
      try {
        await scope.accessor.get(ISessionIndexMirror).drain();
        scope.dispose();
        await drainSessionIndexMirror();
        await drainGlobalSearchDisposals();
        await drainQueryStoreDisposals();
        await drainSessionMetadataWrites();
      } catch {
        // best-effort teardown; the home removal below must still run
      }
      scope = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function bootInjectedServer(): Promise<string> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-injected-'));
    ({ app: scope } = bootstrap(
      { homeDir: home, clientIdentity: TEST_HOST_IDENTITY },
      logSeed(resolveLoggingConfig({ homeDir: home, env: process.env })),
    ));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      core: scope,
    });
    return `http://127.0.0.1:${server.port}`;
  }

  it('serves REST and WS over the SAME live scope the host injected', async () => {
    const base = await bootInjectedServer();
    expect(server?.core).toBe(scope);

    // (a) A session created over server REST is live through the injected scope.
    const created = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const createdBody = (await created.json()) as { code: number; data: { id: string } };
    expect(createdBody.code).toBe(0);
    const sessionId = createdBody.data.id;
    const live = getLiveSessionById((scope as Scope).accessor, sessionId);
    expect(live).toBeDefined();

    // (b) Events published on the injected scope reach a /api/v1/ws subscriber.
    const token = (server as RunningServer).authTokenService.getToken();
    const ws = new WebSocket(`ws://127.0.0.1:${(server as RunningServer).port}/api/v1/ws`, [
      `kimi-code.bearer.${token}`,
    ]);
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const frames: Record<string, unknown>[] = [];
    const waiters: ((frame: Record<string, unknown>) => void)[] = [];
    ws.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else frames.push(frame);
    });
    const nextFrame = (pred: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const hit = frames.findIndex(pred);
        if (hit >= 0) {
          resolve(frames.splice(hit, 1)[0]!);
          return;
        }
        const waiter = (frame: Record<string, unknown>): void => {
          if (pred(frame)) {
            clearTimeout(timer);
            resolve(frame);
            return;
          }
          frames.push(frame);
          waiters.push(waiter);
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timeout waiting for ws frame'));
        }, 5000);
        waiters.push(waiter);
      });
    await nextFrame((f) => f['type'] === 'server_hello');
    ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'h1',
        payload: { client_id: 'injected-core-test', subscriptions: [sessionId], token },
      }),
    );
    await nextFrame((f) => f['type'] === 'ack' && f['id'] === 'h1');

    // The session created over REST has no agents yet — materialize main so
    // there is an event bus to publish on.
    const main = await live!.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    main.accessor
      .get(IEventBus)
      .publish({ type: 'turn.started', turnId: 1 } as unknown as DomainEvent);
    const event = await nextFrame((f) => f['type'] === 'turn.started');
    expect(event['session_id']).toBe(sessionId);

    ws.close();
    await closed;
  });

  it('close() releases server resources but leaves the injected scope alive', async () => {
    const base = await bootInjectedServer();
    const meta = await authedFetch(server as RunningServer, base, '/api/v1/meta');
    expect(meta.status).toBe(200);

    await (server as RunningServer).close();
    server = undefined;

    // Server-owned state went away: the instance registration is released and
    // the port no longer serves.
    expect(await listLiveServerInstances(home as string)).toEqual([]);
    await expect(fetch(`${base}/api/v1/healthz`)).rejects.toThrow();

    // The injected scope is NOT disposed (the double-dispose regression
    // guard): the host can still resolve services and create sessions through
    // it directly.
    expect(() => (scope as Scope).accessor.get(IBootstrapService)).not.toThrow();
    const handler = await (scope as Scope).accessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: home as string });
    const created = await handler.accessor.get(ISessionLifecycleService).create({ workDir: home as string });
    expect(getLiveSessionById((scope as Scope).accessor, created.id)).toBeDefined();
  });
});

function silentLogger() {
  return pino({ level: 'silent' });
}

function addrInUse(): NodeJS.ErrnoException {
  const err = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  err.code = 'EADDRINUSE';
  return err;
}

function listenOnPort(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function closeNetServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Find `port` such that both `port` and `port + 1` are free to bind. */
async function allocateAdjacentFreePair(
  host = '127.0.0.1',
): Promise<{ port: number; next: number }> {
  for (let i = 0; i < 30; i++) {
    const a = await listenOnPort(host, 0);
    const address = a.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await closeNetServer(a);
    if (port <= 0 || port >= 65535) continue;
    const probe = await listenOnPort(host, port + 1).catch(() => null);
    if (probe === null) continue;
    await closeNetServer(probe);
    return { port, next: port + 1 };
  }
  throw new Error('could not allocate an adjacent free port pair');
}

describe('listenWithPortRetry', () => {
  it('returns the requested port when the first listen succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5000);
    expect(attempts).toEqual([5000]);
  });

  it('retries with port+1 on EADDRINUSE until a bind succeeds', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        if (port < 5002) throw addrInUse();
        return `http://127.0.0.1:${String(port)}`;
      },
      host: '127.0.0.1',
      port: 5000,
      logger: silentLogger(),
    });

    expect(result.port).toBe(5002);
    expect(result.address).toBe('http://127.0.0.1:5002');
    expect(attempts).toEqual([5000, 5001, 5002]);
  });

  it('does not retry on non-EADDRINUSE errors', async () => {
    const attempts: number[] = [];
    const boom = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw boom;
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
      }),
    ).rejects.toBe(boom);
    expect(attempts).toEqual([5000]);
  });

  it('throws after exhausting maxRetries', async () => {
    const attempts: number[] = [];
    await expect(
      listenWithPortRetry({
        listen: async (_host, port) => {
          attempts.push(port);
          throw addrInUse();
        },
        host: '127.0.0.1',
        port: 5000,
        logger: silentLogger(),
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // initial attempt + 3 retries, then the cap throws.
    expect(attempts).toEqual([5000, 5001, 5002, 5003]);
  });

  it('does not walk ports when the requested port is 0 (ephemeral)', async () => {
    const attempts: number[] = [];
    const result = await listenWithPortRetry({
      listen: async (_host, port) => {
        attempts.push(port);
        return 'http://127.0.0.1:54321';
      },
      host: '127.0.0.1',
      port: 0,
      logger: silentLogger(),
    });

    expect(result.port).toBe(0);
    expect(attempts).toEqual([0]);
  });
});

describe('server-v2 boot — port retry', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('retries on port+1 and advertises the bound port in the instance registry', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-port-retry-'));
    const { port, next } = await allocateAdjacentFreePair();
    // Occupy the requested port with a raw TCP server (a "third-party" process
    // from the server's point of view — it is not a registered kimi instance).
    const occupant = await listenOnPort('127.0.0.1', port);
    try {
      server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port,
        homeDir: home,
        logLevel: 'silent',
      });

      // Bound to the next available port (>= next); the registry advertises it
      // so status/kill/ps work. On Windows a recently-closed probe port can
      // linger in TIME_WAIT, so the retry may land on port+2 instead of port+1.
      expect(server.port).toBeGreaterThanOrEqual(next);
      const [instance] = await listLiveServerInstances(home);
      expect(instance?.port).toBe(server.port);
    } finally {
      await closeNetServer(occupant);
    }
  });
});
