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
import { IEventService } from '@moonshot-ai/agent-core-v2';
import type { TunnelClientHandle } from '@moonshot-ai/remote-tunnel/agent';

/**
 * Lift the engine's `event.user.notify` facts (the `NotifyUser` tool's
 * surface) onto the hub tunnel as `notify` frames. Both connectors (the
 * TUI's `/remote connect` and the headless `kimi remote connect`) call this
 * once their tunnel is up; the returned handle's `dispose` detaches the
 * subscription (the tunnel's own lifetime is the caller's).
 */
export function wireNotifyBridge(core: Scope, tunnel: TunnelClientHandle): { dispose(): void } {
  return core.accessor.get(IEventService).subscribe((event) => {
    if (event.type !== 'event.user.notify' || typeof event.payload !== 'object' || event.payload === null) {
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
  });
}
