/**
 * `kimi headless` — foreground runner (the daemon child or `--foreground`).
 *
 * Starts the same in-process loopback kap-server as `kimi remote connect`
 * (API-only: no web UI assets — the controlling UI lives on the hub), creates
 * a fresh session for the current working directory (or attaches an existing
 * one via `--session`), then dials OUT to the hub so the hub's web UI is the
 * only control surface. Stays up until SIGINT/SIGTERM (the tunnel closes
 * first, then the regular server shutdown path runs).
 */

import { hostname } from 'node:os';

import { ISessionManager, ISessionMetadata, type Scope } from '@moonshot-ai/agent-core-v2';
import { startTunnelClient, type TunnelClientHandle } from '@moonshot-ai/remote-tunnel/agent';

import { getDataDir } from '#/utils/paths';

import { getVersion } from '../../version';
import { startApiServerForeground, type StartForegroundHooks } from '../web/run';
import { tryResolveServerToken, type ParsedServerOptions } from '../web/shared';
import {
  hubUiUrl,
  parseHubUrl,
  resolveHubToken,
  splitHubTokenFragment,
  wireHubTools,
  wireNotifyBridge,
} from '../remote/shared';

export interface HeadlessOptions {
  /** Hub origin: `http(s)://` or `ws(s)://`; the tunnel client appends `/internal/tunnel`. */
  readonly hubUrl: string;
  /** Hub bearer token; falls back to the `KIMI_HUB_TOKEN` env var. */
  readonly token?: string;
  /** Agent name shown in the hub UI; defaults to this machine's hostname. */
  readonly name?: string;
  /** Existing session to expose; omitted → a new session is created in the cwd. */
  readonly sessionId?: string;
  /** Title assigned to a newly created session. */
  readonly title?: string;
  /** Local server bind options (loopback defaults via `parseServerOptions`). */
  readonly serverOptions: ParsedServerOptions;
}

export async function runHeadless(options: HeadlessOptions): Promise<never> {
  // Resolve + validate before anything binds a port, so a bad flag fails fast.
  const hubUrl = parseHubUrl(options.hubUrl);
  // A pasted `…#token=<t>` link authenticates like an explicit --token; when
  // absent the connection goes tokenless (bypass-mode hubs accept it).
  const hubToken = resolveHubToken(options.token ?? splitHubTokenFragment(options.hubUrl).token) ?? '';
  const agentName = options.name ?? hostname();
  const version = getVersion();

  let tunnel: TunnelClientHandle | undefined;
  let hubTools: { dispose(): void } | undefined;

  const hooks: StartForegroundHooks = {
    onReady: (origin, server) => {
      // Read the token only once the server is up: a fresh server writes
      // `server.token` on first boot (same timing as `kimi web`).
      const localToken = tryResolveServerToken(getDataDir());
      process.stdout.write(`Kimi server: ${origin} (loopback, API only)\n`);
      void (async () => {
        const sessionId =
          options.sessionId ?? (await createSession(server.core, options.title));
        process.stdout.write(
          `${options.sessionId === undefined ? 'created' : 'attached'} session: ${sessionId}\n`,
        );
        process.stdout.write(`connecting to hub ${hubUrl}…\n`);
        tunnel = startTunnelClient({
          hubUrl,
          token: hubToken,
          agent: {
            name: agentName,
            version,
            scope: { sessions: [sessionId] },
            platform: `${process.platform}/${process.arch}`,
            cwd: process.cwd(),
            pid: process.pid,
          },
          local: { httpBase: origin, token: localToken },
          onState: (state) => {
            switch (state.kind) {
              case 'connected':
                process.stdout.write(
                  `connected as ${state.agentId} (${agentName}) — control it from the hub UI\n`,
                );
                process.stdout.write(
                  `hub UI: ${hubUiUrl(hubUrl).replace(/\/$/, '')}#token=${hubToken}\n`,
                );
                return;
              case 'reconnecting':
                process.stdout.write(`reconnecting in ${state.nextDelayMs}ms…\n`);
                return;
              case 'rejected':
                // The hub refused the credential or protocol; reconnecting
                // would not help — fail the command.
                process.stdout.write(`rejected: ${state.reason}\n`);
                process.exit(1);
                return;
              case 'error':
                process.stdout.write(`tunnel error: ${state.message}\n`);
                return;
              case 'connecting':
              case 'closed':
                // Quiet — the surrounding lines cover these.
                return;
            }
          },
        });
        // The NotifyUser tool's events cross to the hub from here on, plus the
        // session's own turn-finish / pending-interaction pings.
        wireNotifyBridge(server.core, tunnel, sessionId);
        // The hub-gated tools (ListHubSessions / SendHubMessage) exist only
        // for as long as the connection publishes them.
        hubTools = wireHubTools(
          server.core,
          { hubUrl, token: hubToken, agentName, agentId: () => tunnel?.agentId() },
          [sessionId],
        );
      })().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    },
    onShutdown: async () => {
      hubTools?.dispose();
      // Close the outbound tunnel before the server goes down (SIGINT/SIGTERM).
      await tunnel?.close();
    },
  };

  return startApiServerForeground(options.serverOptions, hooks);
}

async function createSession(core: Scope, title: string | undefined): Promise<string> {
  const handle = await core.accessor.get(ISessionManager).create({ workDir: process.cwd() });
  if (title !== undefined && title !== '') {
    await handle.accessor.get(ISessionMetadata).setTitle(title);
  }
  return handle.id;
}
