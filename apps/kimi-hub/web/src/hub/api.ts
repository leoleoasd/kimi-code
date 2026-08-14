/**
 * Client for the hub's own API: `GET {hubOrigin}/hub/api/agents` — the roster
 * of agent connections currently dialed into the hub (envelope
 * `{ code: 0, data: { agents } }`, unwrapped by the shared http helper).
 * Hand-validated (this app has no zod dependency): a malformed roster entry
 * is dropped rather than failing the whole list, a malformed body throws.
 *
 * `HubAgentInfo.agentId` is per-connection — a reconnecting agent shows up
 * with a fresh id and the same `name`, so the UI keys selection off the
 * (agent name, session id) pair and re-resolves the live entry on every
 * roster refresh (`resolveSelectedAgent`; the name alone is ambiguous —
 * same-host connections share it while exposing disjoint sessions).
 *
 * Connections can be per-session: a scoped agent's `scope.sessions` lists the
 * session ids this connection exposes, and the UI renders those as a flat
 * remote-session list. Agents WITHOUT a scope are legacy connectors exposing
 * their whole session list — the UI keeps the old drill-in for those.
 */

import { getJson, type HttpEndpoint } from '#/http';

/**
 * The react-query key the roster lives under. Both writers converge here:
 * the 5s REST poll (`fetchHubAgents`) and the live stream overlay
 * (`#/hub/stream`, `setQueryData`) — consumers read a single merged roster.
 */
export const HUB_AGENTS_QUERY_KEY = ['hub', 'agents'] as const;

export interface HubAgentScope {
  readonly sessions: readonly string[];
}

export interface HubAgentInfo {
  readonly agentId: string;
  readonly name: string;
  readonly platform: string;
  readonly arch: string;
  readonly version?: string;
  readonly cwd?: string;
  readonly pid?: number;
  /** Epoch ms when this connection was established. */
  readonly connectedAt: number;
  /** Session-scoped connection: the session ids this agent exposes. */
  readonly scope?: HubAgentScope;
}

/** The kap-server protocol base URL of one agent, tunneled through the hub. */
export function agentBaseUrl(hubOrigin: string, agentId: string): string {
  return `${hubOrigin}/agents/${encodeURIComponent(agentId)}`;
}

/**
 * Re-resolve the (agent name, session id) selection against the live roster.
 * The name alone is not enough: two connections from the same host share it
 * but are scoped to DISJOINT sessions, and a scoped agent refuses sessions
 * outside its scope (`40302`). When a session is selected, the entry whose
 * scope exposes exactly that session owns it; an unscoped (legacy) entry
 * covers its machine's whole session list and matches anything. No such
 * entry ⇒ `null` — NEVER rebind to a same-name entry lacking the session;
 * the caller treats the selection as offline instead.
 */
export function resolveSelectedAgent(
  roster: readonly HubAgentInfo[] | undefined,
  agentName: string | null,
  sessionId: string | null,
): HubAgentInfo | null {
  if (agentName === null || roster === undefined) return null;
  const named = roster.filter((a) => a.name === agentName);
  if (sessionId === null) return named[0] ?? null;
  return (
    named.find((a) => a.scope !== undefined && a.scope.sessions.includes(sessionId)) ??
    named.find((a) => a.scope === undefined) ??
    null
  );
}

function parseScope(value: unknown): HubAgentScope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const sessions = (value as Record<string, unknown>)['sessions'];
  if (!Array.isArray(sessions) || !sessions.every((s): s is string => typeof s === 'string')) {
    return undefined;
  }
  return { sessions };
}

function parseAgent(value: unknown): HubAgentInfo | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const a = value as Record<string, unknown>;
  if (
    typeof a['agentId'] !== 'string' ||
    typeof a['name'] !== 'string' ||
    typeof a['platform'] !== 'string' ||
    typeof a['arch'] !== 'string' ||
    typeof a['connectedAt'] !== 'number'
  ) {
    return undefined;
  }
  return {
    agentId: a['agentId'],
    name: a['name'],
    platform: a['platform'],
    arch: a['arch'],
    version: typeof a['version'] === 'string' ? a['version'] : undefined,
    cwd: typeof a['cwd'] === 'string' ? a['cwd'] : undefined,
    pid: typeof a['pid'] === 'number' ? a['pid'] : undefined,
    connectedAt: a['connectedAt'],
    scope: parseScope(a['scope']),
  };
}

/**
 * Validate a raw `agents` array (REST body or stream frame field): malformed
 * entries are dropped, a non-array value is a hard shape error (`undefined`).
 */
export function parseAgents(value: unknown): readonly HubAgentInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseAgent).filter((a): a is HubAgentInfo => a !== undefined);
}

export async function fetchHubAgents(endpoint: HttpEndpoint): Promise<readonly HubAgentInfo[]> {
  const data = await getJson({ ...endpoint, path: '/hub/api/agents' });
  if (data === null || typeof data !== 'object') {
    throw new Error('hub agents: unexpected response shape');
  }
  const agents = parseAgents((data as { agents?: unknown }).agents);
  if (agents === undefined) {
    throw new Error('hub agents: unexpected response shape');
  }
  return agents;
}
