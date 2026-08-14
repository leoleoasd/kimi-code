/**
 * Shared parsing for `kimi remote connect` and the TUI `/remote` command.
 *
 * Owns the hub URL scheme check, the hub token resolution order
 * (`--token` > `KIMI_HUB_TOKEN`), and the `/remote` argument grammar.
 */

/** Environment variable holding the shared hub credential. */
export const HUB_TOKEN_ENV = 'KIMI_HUB_TOKEN';

/**
 * Split the `#token=<t>` credential fragment (the form printed by the hub
 * startup banner and the connect output) off a pasted hub URL. Users paste
 * that link whole; the fragment is both how they authenticate and noise the
 * tunnel client must not see.
 */
export function splitHubTokenFragment(hubUrl: string): { origin: string; token?: string } {
  const marker = '#token=';
  const idx = hubUrl.indexOf(marker);
  if (idx === -1 || idx + marker.length === hubUrl.length) return { origin: hubUrl };
  return { origin: hubUrl.slice(0, idx), token: hubUrl.slice(idx + marker.length) };
}

/**
 * Validate a hub URL: `http(s)://` or `ws(s)://` (the tunnel client appends
 * `/internal/tunnel` itself). A trailing `#token=` fragment is stripped.
 * Returns the trimmed URL.
 */
export function parseHubUrl(raw: string): string {
  const url = splitHubTokenFragment(raw.trim()).origin;
  if (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('ws://') ||
    url.startsWith('wss://')
  ) {
    return url;
  }
  throw new Error(`error: invalid hub URL: ${raw} (expected http(s):// or ws(s)://)`);
}

/**
 * Browser-facing hub UI URL for a validated hub URL: `ws(s)://` schemes are
 * mapped back to `http(s)://` (the tunnel speaks WS, the UI is plain HTTP).
 */
export function hubUiUrl(hubUrl: string): string {
  return hubUrl.replace(/^ws(s?):\/\//, 'http$1://');
}

/**
 * Resolve the shared hub credential: an explicit `--token` value first, then
 * the `KIMI_HUB_TOKEN` environment variable. Optional: a tokenless connection
 * is valid for hubs started with `--dangerous-bypass-auth` — a strict hub
 * will simply refuse the handshake (4401) on its side.
 */
export function resolveHubToken(
  flagValue?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = flagValue !== undefined && flagValue !== '' ? flagValue : env[HUB_TOKEN_ENV];
  return token === undefined || token.trim() === '' ? undefined : token;
}

export type ParsedRemoteCommand =
  | {
      readonly kind: 'connect';
      readonly hubUrl: string;
      readonly token?: string;
      readonly name?: string;
    }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'status' }
  | { readonly kind: 'error'; readonly message: string };

const REMOTE_USAGE = 'usage: /remote connect <hub-url> [--token <t>] | disconnect | status';

/**
 * Parse the `/remote` argument string: `connect <hub-url> [--token <t>]
 * [--name <n>]`, `disconnect`, or `status` (bare `/remote` also reports the
 * connection state). The hub-facing `connect` mirrors the CLI's
 * `kimi remote connect`.
 */
export function parseRemoteCommand(rawArgs: string): ParsedRemoteCommand {
  const args = rawArgs.trim().split(/\s+/).filter((arg) => arg.length > 0);
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === 'status') {
    return args.length <= 1 ? { kind: 'status' } : { kind: 'error', message: REMOTE_USAGE };
  }
  if (subcommand === 'disconnect') {
    return args.length === 1 ? { kind: 'disconnect' } : { kind: 'error', message: REMOTE_USAGE };
  }
  if (subcommand !== 'connect') {
    return { kind: 'error', message: REMOTE_USAGE };
  }
  let hubUrl: string | undefined;
  let token: string | undefined;
  let name: string | undefined;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      if (flag !== '--token' && flag !== '--name') {
        return { kind: 'error', message: `unknown flag: ${flag}\n${REMOTE_USAGE}` };
      }
      const value = eq === -1 ? rest[++i] : arg.slice(eq + 1);
      if (value === undefined) {
        return { kind: 'error', message: `${flag} requires a value\n${REMOTE_USAGE}` };
      }
      if (flag === '--token') token = value;
      else name = value;
      continue;
    }
    if (hubUrl !== undefined) {
      return { kind: 'error', message: `unexpected argument: ${arg}\n${REMOTE_USAGE}` };
    }
    hubUrl = arg;
  }
  if (hubUrl === undefined) {
    return { kind: 'error', message: REMOTE_USAGE };
  }
  // Pasted banner links carry the credential: adopt it unless --token was given.
  const fragment = splitHubTokenFragment(hubUrl);
  return { kind: 'connect', hubUrl: fragment.origin, token: token ?? fragment.token, name };
}

// ---------------------------------------------------------------------------
// Notify bridge: agent engine → hub
// ---------------------------------------------------------------------------

import type { Scope } from '@moonshot-ai/agent-core-v2';
import {
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentToolRegistryService,
  type IAgentScopeHandle,
  IEventBus,
  IEventService,
  IHubConnectionService,
  IListHubSessionsTool,
  ISendHubMessageTool,
  ISessionInteractionService,
  type IDisposable,
} from '@moonshot-ai/agent-core-v2';
import type { TunnelClientHandle } from '@moonshot-ai/remote-tunnel/agent';

/**
 * Lift engine user-notification surfaces onto the hub tunnel as `notify`
 * frames. Both connectors (the TUI's `/remote connect` and the headless
 * `kimi remote connect`) call this once their tunnel is up; the returned
 * handle's `dispose` detaches every subscription (the tunnel's own lifetime
 * is the caller's). Sources:
 *
 *  1. the `NotifyUser` tool's `event.user.notify` fact (App-scope);
 *  2. `turn.ended` (reason `completed`) on the attached session's agent
 *     buses — the engine's own ping so a finished turn wakes devices with no
 *     page open, on every connected session (independent of which chat is
 *     mounted client-side);
 *  3. newly pending approvals / questions of that session.
 */
export function wireNotifyBridge(
  core: Scope,
  tunnel: TunnelClientHandle,
  sessionId?: string,
): { dispose(): void } {
  const disposals: IDisposable[] = [];
  disposals.push(
    core.accessor.get(IEventService).subscribe((event) => {
      if (
        event.type !== 'event.user.notify' ||
        typeof event.payload !== 'object' ||
        event.payload === null
      ) {
        return;
      }
      const payload = event.payload as Record<string, unknown>;
      if (
        typeof payload['notificationId'] !== 'string' ||
        typeof payload['sessionId'] !== 'string' ||
        typeof payload['title'] !== 'string' ||
        typeof payload['body'] !== 'string'
      ) {
        return;
      }
      tunnel.notify({
        notificationId: payload['notificationId'],
        sessionId: payload['sessionId'],
        agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : undefined,
        title: payload['title'],
        body: payload['body'],
      });
    }),
  );
  if (sessionId !== undefined) {
    disposals.push(wireSessionTurnNotify(core, tunnel, sessionId));
  }
  const dispose = (): void => {
    for (const d of disposals.splice(0)) d.dispose();
  };
  return { dispose };
}

/**
 * Per-session taps: `turn.ended(completed)` + pending interactions of every
 * agent in the attached session. Mirror of the broadcaster's reach-down
 * pattern into agent buses; a cold session (possible for headless connects)
 * silently contributes nothing — the scope check keeps it from registering
 * live traffic for an unknown id.
 */
function wireSessionTurnNotify(
  core: Scope,
  tunnel: TunnelClientHandle,
  sessionId: string,
): IDisposable {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) return { dispose(): void {} };
  const disposables: IDisposable[] = [];
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  const subscribeAgent = (handle: { id: string; accessor: { get(t: typeof IEventBus): IEventBus } }): IDisposable =>
    handle.accessor.get(IEventBus).subscribe((event) => {
      if (event.type !== 'turn.ended' || event.reason !== 'completed') return;
      tunnel.notify({
        notificationId: `idle/${sessionId}/${handle.id}/t${event.turnId}`,
        sessionId,
        agentId: handle.id,
        title: `${handle.id} finished`,
        body: 'the turn completed',
      });
    });
  for (const handle of lifecycle.list()) disposables.push(subscribeAgent(handle));
  disposables.push(
    lifecycle.onDidCreate((handle) => disposables.push(subscribeAgent(handle))),
  );

  const interactions = session.accessor.get(ISessionInteractionService);
  const knownPending = new Set(interactions.listPending().map((pending) => pending.id));
  disposables.push(
    interactions.onDidChangePending(() => {
      for (const pending of interactions.listPending()) {
        if (knownPending.has(pending.id)) continue;
        knownPending.add(pending.id);
        if (pending.kind !== 'approval' && pending.kind !== 'question') continue;
        tunnel.notify({
          notificationId: `interaction/${sessionId}/${pending.id}`,
          sessionId,
          title: `${pending.origin?.agentId ?? 'agent'} is waiting for your input`,
          body:
            pending.kind === 'question'
              ? 'a question is waiting for an answer'
              : 'an approval is waiting for a decision',
        });
      }
    }),
  );
  return {
    dispose(): void {
      for (const d of disposables.splice(0)) d.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Hub tools: agent-initiated hub calls (ListHubSessions / SendHubMessage)
// ---------------------------------------------------------------------------

export interface HubToolWiring {
  /** Extend registration to a session bridged later (the TUI's scope union can widen on a live connection). */
  attachSession(sessionId: string): void;
  dispose(): void;
}

/**
 * Register the hub-gated agent tools (`ListHubSessions` / `SendHubMessage`)
 * on every agent of the bridged session(s), and publish the connection
 * (URL + shared token) those tools use for their HTTPS calls to the hub
 * (roster read + cross-session prompt submit — the tunnel protocol itself
 * has no such agent→hub channel). Registration is DIRECT on the per-agent
 * registry, not the static contribution fold: agents in a process that
 * never remote-connects must not see these tools at all. `dispose` removes
 * the tools and forgets the connection (both connectors call it on
 * disconnect / shutdown).
 */
export function wireHubTools(
  core: Scope,
  cfg: { hubUrl: string; token: string; agentName?: string },
  sessionIds: readonly string[],
): HubToolWiring {
  const disposables: IDisposable[] = [];
  const bridged: string[] = [];
  const publishConfig = (): void => {
    core.accessor.get(IHubConnectionService).configure({
      hubUrl: cfg.hubUrl,
      token: cfg.token,
      agentName: cfg.agentName,
      sessionIds: [...bridged],
    });
  };
  const attachSession = (sessionId: string): void => {
    if (sessionId === '' || bridged.includes(sessionId)) return;
    bridged.push(sessionId);
    publishConfig();
    const session = getLiveSessionById(core.accessor, sessionId);
    if (session === undefined) return;
    const lifecycle = session.accessor.get(IAgentLifecycleService);
    const register = (handle: IAgentScopeHandle): void => {
      const registry = handle.accessor.get(IAgentToolRegistryService);
      disposables.push(
        registry.register(handle.accessor.get(IListHubSessionsTool), { source: 'builtin' }),
        registry.register(handle.accessor.get(ISendHubMessageTool), { source: 'builtin' }),
      );
    };
    for (const handle of lifecycle.list()) register(handle);
    disposables.push(lifecycle.onDidCreate(register));
  };
  for (const sessionId of sessionIds) attachSession(sessionId);
  return {
    attachSession,
    dispose(): void {
      for (const d of disposables.splice(0)) d.dispose();
      bridged.length = 0;
      core.accessor.get(IHubConnectionService).configure(undefined);
    },
  };
}
