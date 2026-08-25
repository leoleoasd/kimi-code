import { hostname } from 'node:os';

import { startServer, type RunningServer } from '@moonshot-ai/kap-server';
import {
  startTunnelClient,
  type TunnelClientHandle,
  type TunnelClientState,
} from '@moonshot-ai/remote-tunnel/agent';

import {
  hubUiUrl,
  type HubToolWiring,
  parseHubUrl,
  parseRemoteCommand,
  resolveHubToken,
  wireHubTools,
  wireNotifyBridge,
} from '#/cli/sub/remote/shared';
import {
  DEFAULT_SERVER_PORT,
  LOCAL_SERVER_HOST,
  serverOrigin,
  tryResolveServerToken,
} from '#/cli/sub/web/shared';
import { createKimiCodeHostIdentity } from '#/cli/version';

import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { TuiConfig } from '../config';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { createTuiCommandBridge } from './remote-bridge';

/**
 * The runner the command bridge hands remote lines to. `dispatch.ts` owns the
 * grammar AND imports this module, so the runner arrives by registration
 * (`registerRemoteSlashRunner`, called at dispatch module init) — a direct
 * import here would close an import cycle. Unregistered (unit tests calling
 * this module alone) means "no bridge", which is a valid server start.
 */
export type RemoteSlashRunner = (host: SlashCommandHost, input: string) => Promise<void>;
let slashRunner: RemoteSlashRunner | undefined;
export function registerRemoteSlashRunner(run: RemoteSlashRunner): void {
  slashRunner = run;
}

/**
 * `/remote connect <hub-url> [--token <t>]` — Claude Code-style remote
 * control: the TUI STAYS interactive and an in-process loopback kap-server +
 * hub tunnel serve THIS live engine (the harness's v2 scope, injected into
 * `startServer({ core })`), so the hub sees and drives the same session the
 * TUI is showing. `disconnect` tears the tunnel + embedded server down;
 * `status` (or bare `/remote`) reports the connection.
 *
 * The connection is scoped (`agent.scope.sessions`) so the hub can never
 * reach anything else on this machine — and the scope FOLLOWS the TUI as a
 * UNION: every session this process ever showed (reported through
 * `notifyRemoteSessionChanged` from the session-switch funnel) joins the set
 * and never leaves it. A live connection pushes each widening as a
 * `scope.update` frame (`TunnelClientHandle.updateScope`); the union survives
 * `/remote disconnect` + `/remote connect` because it is module-level.
 * One live connection per TUI process.
 */
interface RemoteConnection {
  readonly hubUrl: string;
  readonly agentName: string;
  readonly sessionId: string;
  readonly server: RunningServer;
  readonly tunnel: TunnelClientHandle;
  /** The `event.user.notify` → tunnel subscription; torn down with the connection. */
  readonly notifyBridge: { dispose(): void };
  /** Hub-gated tool registration (`ListHubSessions` / `SendHubMessage`) + the connection those tools call back to. */
  readonly hubTools: HubToolWiring;
  tunnelState: TunnelClientState;
  agentId: string | undefined;
}

/**
 * Every session this process has EVER bridged, in first-seen insertion order.
 * A bridged session stays bridged for the process's lifetime — including
 * across `/remote disconnect` + `/remote connect` — since a session the user
 * has already gone back to mid-bridge must never silently drop off the hub.
 * No cap, no reorder: the hub's per-frame filter set is the caller-owned union;
 * the tunnel only ever re-declares it verbatim.
 */
const scopedSessionIds: string[] = [];

function trackScopedSession(sid: string): void {
  if (sid === '' || scopedSessionIds.includes(sid)) return;
  scopedSessionIds.push(sid);
}

/**
 * Scope-follow seam: `KimiTUI.syncRuntimeState` — the funnel every
 * create/resume/reload path goes through — reports the ACTIVE session here,
 * and the bridge unions it into the scoped set. With a live connection the
 * widened union is pushed as a `scope.update` frame; without one it is only
 * recorded, and the next connect's hello carries it. A repeated (or empty) id
 * is a strict no-op. (No flush is needed on the tunnel's `connected` state:
 * the first hello carries the union, and the tunnel client re-declares the
 * latest wanted scope on every reconnect.)
 */
/** True while the hub tunnel carries traffic (mounted into the footer status line). */
export function isRemoteConnected(): boolean {
  return connection !== undefined && connection.tunnelState.kind === 'connected';
}

export function notifyRemoteSessionChanged(sid: string): void {
  const before = scopedSessionIds.length;
  trackScopedSession(sid);
  if (scopedSessionIds.length === before) return;
  connection?.tunnel.updateScope([...scopedSessionIds]);
  connection?.hubTools.attachSession(sid);
}

let connection: RemoteConnection | undefined;
let exitHookInstalled = false;
let autoConnectAttempted = false;

/**
 * tui.toml `[remote]` hub_url auto-connect, fired from the session-switch
 * funnel (`KimiTUI.syncRuntimeState`) so the connect never races an absent
 * session. One-shot per process: a refusal, a manual `/remote disconnect`, or
 * a successful connect all leave it quiet for the rest of the process — only
 * explicit `/remote connect` reconnects after that.
 */
export function maybeAutoConnectRemote(host: SlashCommandHost, config: TuiConfig): void {
  if (autoConnectAttempted || connection !== undefined) return;
  const hubUrl = config.remote?.hubUrl;
  if (!hubUrl || host.session === undefined) return;
  autoConnectAttempted = true;
  void connectRemote(host, hubUrl, config.remote?.token ?? undefined, config.remote?.name ?? undefined);
}

export async function handleRemoteCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseRemoteCommand(args);
  switch (parsed.kind) {
    case 'error':
      host.showError(parsed.message);
      return;
    case 'status':
      showRemoteStatus(host);
      return;
    case 'disconnect':
      await disconnectRemote(host);
      return;
    case 'connect':
      await connectRemote(host, parsed.hubUrl, parsed.token, parsed.name);
      return;
  }
}

async function connectRemote(
  host: SlashCommandHost,
  hubUrlRaw: string,
  tokenFlag: string | undefined,
  nameFlag: string | undefined,
): Promise<void> {
  if (connection !== undefined) {
    host.showError(`Already connected to ${connection.hubUrl} — run /remote disconnect first.`);
    return;
  }
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  // Validate while the error can still be shown in the TUI. The hub token is
  // optional — bypass-mode hubs accept tokenless connections, strict ones
  // refuse the handshake on their side.
  let hubUrl: string;
  try {
    hubUrl = parseHubUrl(hubUrlRaw);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    return;
  }
  const hubToken = resolveHubToken(tokenFlag) ?? '';

  const engineScope = host.harness.engineScope;
  if (engineScope === undefined) {
    host.showError('/remote connect requires the v2 engine — this TUI is running the legacy one.');
    return;
  }

  const version = host.state.appState.version;
  const agentName = nameFlag ?? hostname();
  let server: RunningServer;
  try {
    // API-only loopback server over THIS live engine: no web UI assets (the
    // controlling UI lives on the hub) and no second bootstrap — the injected
    // scope stays the harness's; closing the server never disposes it.
    server = await startServer({
      core: engineScope,
      homeDir: host.harness.homeDir,
      host: LOCAL_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      logLevel: 'silent',
      insecureNoTls: true,
      serverVersion: version,
      hostIdentity: createKimiCodeHostIdentity(version),
      // The hub web runs THIS TUI's slash commands over `:command` — the
      // grammar lives here, nowhere else.
      commandBridge: slashRunner === undefined ? undefined : createTuiCommandBridge(host, slashRunner),
    });
  } catch (error) {
    host.showError(`Failed to start the local server: ${formatErrorMessage(error)}`);
    return;
  }

  const origin = serverOrigin(server.host, server.port);
  // The connect-time session joins the union; ids recorded before any
  // connection existed (notified while unbridged) ride along in the hello.
  trackScopedSession(session.id);
  let conn!: RemoteConnection;
  let tunnel: TunnelClientHandle;
  try {
    tunnel = startTunnelClient({
      hubUrl,
      token: hubToken,
      agent: { name: agentName, version, scope: { sessions: [...scopedSessionIds] } },
      // A fresh server writes `server.token` on first boot — read it back now
      // that the server is up (same timing as `kimi web`).
      local: { httpBase: origin, token: tryResolveServerToken(host.harness.homeDir) },
      onState: (state) => {
        // The client may emit state synchronously before the `conn` record is
        // registered (its first `connecting` fires from the constructor); drop
        // anything that precedes registration — later/quiet frames cover it.
        const current = connection;
        if (current === undefined) return;
        onTunnelState(host, current, state);
      },
    });
  } catch (error) {
    await server.close().catch(() => undefined);
    host.showError(`Failed to connect to the hub: ${formatErrorMessage(error)}`);
    return;
  }
  conn = {
    hubUrl,
    agentName,
    sessionId: session.id,
    server,
    tunnel,
    notifyBridge: wireNotifyBridge(engineScope, tunnel, session.id),
    hubTools: wireHubTools(
      engineScope,
      { hubUrl, token: hubToken, agentName, agentId: () => tunnel.agentId() },
      [...scopedSessionIds],
    ),
    tunnelState: { kind: 'connecting' },
    agentId: undefined,
  };
  connection = conn;
  installExitHook();
  host.showStatus(`Remote control: connecting to ${hubUrl}…`);
}

async function disconnectRemote(host: SlashCommandHost): Promise<void> {
  const conn = connection;
  if (conn === undefined) {
    host.showStatus('Remote control is not connected.');
    return;
  }
  connection = undefined;
  // The union is module state and deliberately survives: the next connect's
  // hello re-bridges every session this process ever exposed.
  await closeConnection(conn);
  host.showStatus('Remote control disconnected.');
}

function showRemoteStatus(host: SlashCommandHost): void {
  const conn = connection;
  if (conn === undefined) {
    host.showStatus('Remote control is not connected.');
    return;
  }
  host.showNotice(
    'Remote control',
    [
      `hub:     ${conn.hubUrl}`,
      `agent:   ${conn.agentId ?? '—'} (${conn.agentName})`,
      `session: ${conn.sessionId}`,
      `local:   ${serverOrigin(conn.server.host, conn.server.port)}`,
      `state:   ${tunnelStateLabel(conn.tunnelState)}`,
    ].join('\n'),
  );
}

function onTunnelState(host: SlashCommandHost, conn: RemoteConnection, state: TunnelClientState): void {
  // A torn-down connection must not speak: its tunnel emits `closed` during
  // close(), and late reconnecting frames would resurrect it in the status.
  if (connection !== conn) return;
  conn.tunnelState = state;
  switch (state.kind) {
    case 'connected':
      conn.agentId = state.agentId;
      host.showNotice(
        'Remote control connected',
        [
          `hub:     ${conn.hubUrl}`,
          `agent:   ${state.agentId} (${conn.agentName})`,
          `session: ${conn.sessionId}`,
          `Manage it from the hub UI: ${hubUiUrl(conn.hubUrl).replace(/\/$/, '')}`,
        ].join('\n'),
      );
      return;
    case 'reconnecting':
      host.showStatus(`Remote control: reconnecting in ${String(state.nextDelayMs)}ms…`, 'warning');
      return;
    case 'rejected':
      // The hub refused the credential or protocol; reconnecting would not
      // help — drop the whole setup. The union still survives (module state).
      connection = undefined;
      host.showError(`Remote control rejected: ${state.reason}`);
      void closeConnection(conn);
      return;
    case 'error':
      host.showStatus(`Remote control tunnel error: ${state.message}`, 'warning');
      return;
    case 'connecting':
    case 'closed':
      // Quiet — the surrounding status lines cover these.
      return;
  }
}

/** Close the tunnel first (stop remote traffic), then the embedded server. */
async function closeConnection(conn: RemoteConnection): Promise<void> {
  conn.hubTools.dispose();
  conn.notifyBridge.dispose();
  try {
    await conn.tunnel.close();
  } catch {
    // best-effort teardown
  }
  try {
    await conn.server.close();
  } catch {
    // best-effort teardown
  }
}

function tunnelStateLabel(state: TunnelClientState): string {
  switch (state.kind) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'reconnecting':
      return `reconnecting (attempt ${String(state.attempt)})`;
    case 'rejected':
      return `rejected: ${state.reason}`;
    case 'error':
      return `error: ${state.message}`;
    case 'closed':
      return 'closed';
  }
}

/**
 * Best-effort teardown on process exit: the TUI's engine teardown
 * (`KimiTUI.stop()` → harness close) disposes the scope the embedded server
 * serves, so the server's remaining lifetime is the exit path anyway —
 * dropping the tunnel here lets the hub see the agent leave promptly. There
 * is no slash-command shutdown hook on the host, so `exit` is the hook.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    const conn = connection;
    connection = undefined;
    if (conn !== undefined) {
      try {
        void conn.tunnel.close();
      } catch {
        // exit path must never throw
      }
    }
  });
}
