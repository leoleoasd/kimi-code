/**
 * `kimi remote connect` — attach this machine to a running kimi hub.
 *
 * Starts the same in-process loopback kap-server as `kimi web` (API-only: no
 * web UI assets — the controlling UI lives on the hub), then dials OUT to the
 * hub over the reverse tunnel (`@moonshot-ai/remote-tunnel/agent`) so the
 * hub's web UI can list and control this machine's sessions. Stays in the
 * foreground until Ctrl+C (SIGINT/SIGTERM closes the tunnel first, then the
 * regular server shutdown path runs).
 */

import { hostname } from 'node:os';

import { startTunnelClient, type TunnelClientHandle } from '@moonshot-ai/remote-tunnel/agent';

import { getDataDir } from '#/utils/paths';

import { getVersion } from '../../version';
import { startApiServerForeground, type StartForegroundHooks } from '../web/run';
import { tryResolveServerToken, type ParsedServerOptions } from '../web/shared';
import { hubUiUrl, parseHubUrl, resolveHubToken, splitHubTokenFragment, wireHubTools, wireNotifyBridge } from './shared';

export interface RemoteConnectOptions {
  /** Hub origin: `http(s)://` or `ws(s)://`; the tunnel client appends `/internal/tunnel`. */
  readonly hubUrl: string;
  /** Hub bearer token; falls back to the `KIMI_HUB_TOKEN` env var. */
  readonly token?: string;
  /** Agent name shown in the hub UI; defaults to this machine's hostname. */
  readonly name?: string;
  /**
   * The session this connection exposes on the hub. Every connection is
   * session-scoped (the hub refuses anything outside it), so this is required.
   */
  readonly sessionId: string;
  /** Local server bind options (loopback defaults via `parseServerOptions`). */
  readonly serverOptions: ParsedServerOptions;
}

export async function runRemoteConnect(options: RemoteConnectOptions): Promise<never> {
  // Resolve + validate before anything binds a port, so a bad flag fails fast.
  const hubUrl = parseHubUrl(options.hubUrl);
  // A pasted `…#token=<t>` link authenticates like an explicit --token; when
  // absent the connection goes tokenless (bypass-mode hubs accept it).
  const hubToken = resolveHubToken(options.token ?? splitHubTokenFragment(options.hubUrl).token) ?? '';
  if (options.sessionId.trim() === '') {
    throw new Error('error: missing session id: pass --session <id>');
  }
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
      process.stdout.write(`connecting to hub ${hubUrl}…\n`);
      tunnel = startTunnelClient({
        hubUrl,
        token: hubToken,
        agent: { name: agentName, version, scope: { sessions: [options.sessionId] } },
        local: { httpBase: origin, token: localToken },
        onState: (state) => {
          switch (state.kind) {
            case 'connected':
              process.stdout.write(
                `connected as ${state.agentId} (${agentName}) — control it from the hub UI\n`,
              );
              process.stdout.write(`hub UI: ${hubUiUrl(hubUrl).replace(/\/$/, '')}#token=${hubToken}\n`);
              return;
            case 'reconnecting':
              process.stdout.write(`reconnecting in ${state.nextDelayMs}ms…\n`);
              return;
            case 'rejected':
              // The hub refused the credential or protocol; reconnecting would
              // not help — fail the command.
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
      // attached session's own turn-finish / pending-interaction pings.
      wireNotifyBridge(server.core, tunnel, options.sessionId);
      // The hub-gated tools (ListHubSessions / SendHubMessage) exist only for
      // as long as the connection publishes them.
      hubTools = wireHubTools(
        server.core,
        { hubUrl, token: hubToken, agentName },
        [options.sessionId],
      );
    },
    onShutdown: async () => {
      hubTools?.dispose();
      // Close the outbound tunnel before the server goes down (SIGINT/SIGTERM).
      await tunnel?.close();
    },
  };

  return startApiServerForeground(options.serverOptions, hooks);
}
