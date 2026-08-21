/**
 * Left rail: a FLAT list of remote sessions — the session is the primary
 * entity (scoped agents connect per-session; `scope.sessions` lists the ids
 * they expose). Each row shows a lazily fetched session title, a live status
 * dot (polled for the open entry only), and the agent as subtitle chips.
 * Agents WITHOUT a scope are legacy connectors and keep the old drill-in at
 * the bottom (per-agent session list + "new session").
 *
 * Selection is keyed by (agent NAME, session id) — the hub hands reconnects a
 * fresh `agentId`, so the shell re-resolves the live entry from the roster on
 * every refresh. A scoped agent that drops out of the roster keeps its rows
 * as grey, non-interactive offline entries instead of rows vanishing on a
 * transient gap; the shell keys last-seen info by (name, session id) so
 * same-host connections (which SHARE the name) keep their own last-seen
 * agent in their own row.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';

import { useConnection } from '#/connection';
import { agentBaseUrl, type HubAgentInfo } from '#/hub/api';
import {
  createSession,
  fetchSessions,
} from '#/sessions/api';
import { SessionList } from './SessionList';
import { ErrorLine, relTime } from './ui';

// ------------------------------------------------------------------ model

/** One flat rail row: a remote session exposed by one (named) agent. */
export interface RailSessionEntry {
  readonly key: string;
  readonly agentName: string;
  readonly sessionId: string;
  /** Live roster entry when online, last-seen copy when offline. */
  readonly agent: HubAgentInfo;
  readonly online: boolean;
}

export interface RailModel {
  readonly sessions: readonly RailSessionEntry[];
  /** Online agents without a scope — old drill-in behavior. */
  readonly legacy: readonly HubAgentInfo[];
}

/** Reconnect-stable React key: name + session id, never the agentId. */
export function railKey(agentName: string, sessionId: string): string {
  return `${agentName}${sessionId}`;
}

/**
 * Derive the rail from the live roster plus the last-seen-online roster.
 * Scoped agents contribute one online entry per exposed session id, in
 * roster order. `lastSeenSessions` is keyed by (agent name, session id) —
 * same-host connections SHARE the name, so each dropped connection keeps its
 * own entries: the offline half re-emits the scoped ids of every DISTINCT
 * last-seen agent whose name is missing from the live roster. Once the name
 * is back in the roster, its live scope is authoritative again (stale rows
 * drop).
 */
export function deriveRailModel(
  live: readonly HubAgentInfo[],
  lastSeenSessions: ReadonlyMap<string, HubAgentInfo>,
): RailModel {
  const sessions: RailSessionEntry[] = [];
  const legacy: HubAgentInfo[] = [];
  for (const agent of live) {
    if (agent.scope === undefined) {
      legacy.push(agent);
      continue;
    }
    for (const sessionId of agent.scope.sessions) {
      sessions.push({
        key: railKey(agent.name, sessionId),
        agentName: agent.name,
        sessionId,
        agent,
        online: true,
      });
    }
  }
  const liveNames = new Set(live.map((a) => a.name));
  const emitted = new Set<string>();
  for (const agent of lastSeenSessions.values()) {
    if (liveNames.has(agent.name) || agent.scope === undefined) continue;
    for (const sessionId of agent.scope.sessions) {
      // One agent sits under a key per exposed session — emit each row once.
      const key = railKey(agent.name, sessionId);
      if (emitted.has(key)) continue;
      emitted.add(key);
      sessions.push({
        key,
        agentName: agent.name,
        sessionId,
        agent,
        online: false,
      });
    }
  }
  return { sessions, legacy };
}

// ------------------------------------------------------------------ rail

export function SessionRail({
  roster,
  lastSeenSessions,
  selectedAgentName,
  onSelectAgent,
  selectedSessionId,
  onSelectSession,
}: {
  roster: UseQueryResult<readonly HubAgentInfo[]>;
  /** Last-seen agents keyed by (name, session id) (owned by the shell); backs the offline rows of dropped agents. */
  lastSeenSessions: ReadonlyMap<string, HubAgentInfo>;
  selectedAgentName: string | null;
  onSelectAgent: (name: string) => void;
  selectedSessionId: string | null;
  onSelectSession: (agentName: string, sessionId: string) => void;
}) {
  const agents = roster.data ?? [];
  const { sessions, legacy } = deriveRailModel(agents, lastSeenSessions);
  const selectedGone =
    selectedAgentName !== null && !roster.isLoading && agents.every((a) => a.name !== selectedAgentName);

  return (
    <div className="flex h-full w-full flex-col bg-(--app-surface)">
      <div className="border-b border-neutral-800 px-3 py-2">
        <div className="text-[12px] font-semibold text-neutral-200">Sessions</div>
        <div className="text-[10px] text-neutral-600">
          remote sessions exposed to this hub — refreshes every 5s
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {roster.isError ? (
          <div className="m-3">
            <ErrorLine error={roster.error} />
          </div>
        ) : sessions.length === 0 && legacy.length === 0 ? (
          <div className="m-3 text-[11px] text-neutral-600 italic">
            {roster.isLoading
              ? 'Loading sessions…'
              : 'No sessions exposed yet. Run `kimi remote connect <hub-url>` on a machine to add one here.'}
          </div>
        ) : (
          <>
            <div>
              {sessions.map((entry) => (
                <ScopedSessionEntry
                  key={entry.key}
                  entry={entry}
                  selected={
                    entry.agentName === selectedAgentName && entry.sessionId === selectedSessionId
                  }
                  onSelect={() => {
                    onSelectSession(entry.agentName, entry.sessionId);
                  }}
                />
              ))}
            </div>
            {legacy.length > 0 ? (
              <div>
                <div className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
                  Legacy agents
                </div>
                {legacy.map((agent) => (
                  <LegacyAgentEntry
                    key={agent.agentId}
                    agent={agent}
                    selected={agent.name === selectedAgentName}
                    selectedSessionId={agent.name === selectedAgentName ? selectedSessionId : null}
                    onSelect={() => {
                      onSelectAgent(agent.name);
                    }}
                    onSelectSession={(sessionId) => {
                      onSelectSession(agent.name, sessionId);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
        {selectedGone ? (
          <div className="m-3 text-[11px] text-amber-300/80">
            “{selectedAgentName}” is not connected right now — its sessions return when it
            reconnects.
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ scoped

function ScopedSessionEntry({
  entry,
  selected,
  onSelect,
}: {
  entry: RailSessionEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  const { hubOrigin, token } = useConnection();
  const baseUrl = agentBaseUrl(hubOrigin, entry.agent.agentId);
  const shortId = `${entry.sessionId.slice(0, 8)}…`;

  // Title + status dot for EVERY online row come from the per-agent session
  // list — the query key is shared with the legacy drill-in, one 5s poll loop
  // per agent covers all its rows. A TUI rename flips the row on the next
  // poll tick; when the same agent's chat is open, the
  // `session.meta.updated` WS frame flips the open chat's header instantly.
  // Offline rows stay muted regardless.
  const sessions = useQuery({
    queryKey: ['sessions', baseUrl],
    queryFn: () => fetchSessions({ baseUrl, token }),
    enabled: entry.online,
    refetchInterval: 5000,
  });
  const summary = sessions.data?.find((s) => s.id === entry.sessionId);
  const activity = summary?.activity.status;
  const label = summary?.meta.title ?? summary?.meta.lastPrompt ?? shortId;
  const working =
    activity === 'running' || activity === 'approval' || activity === 'question';
  const dot = !entry.online
    ? 'bg-neutral-600'
    : activity === 'failed'
      ? 'bg-red-400'
      : working
        ? 'bg-amber-400'
        : 'bg-emerald-400';
  const dotTitle = !entry.online
    ? 'agent offline'
    : working
      ? 'session busy'
      : activity === 'failed'
        ? 'session failed'
        : 'session idle';

  return (
    <button
      className={`flex min-h-[44px] w-full items-start gap-2 border-b border-neutral-800/60 px-3 py-2 text-left ${
        entry.online ? 'hover:bg-neutral-900 active:bg-neutral-800' : 'cursor-default'
      } ${selected && entry.online ? 'bg-neutral-900' : ''}`}
      disabled={!entry.online}
      title={entry.online ? entry.sessionId : `${shortId} — agent offline`}
      onClick={onSelect}
    >
      <span
        className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${dot} ${
          working && entry.online ? 'pulse-dot' : ''
        }`}
        title={dotTitle}
      />
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[12px] ${
            entry.online ? 'text-neutral-200' : 'text-neutral-600'
          }`}
        >
          {label}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          <span className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-400">
            {entry.agent.name}
          </span>
          <span className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-400">
            {entry.agent.platform}/{entry.agent.arch}
          </span>
          {entry.online ? (
            <span className="text-[9px] text-neutral-600">{relTime(entry.agent.connectedAt)}</span>
          ) : (
            <span className="text-[9px] text-neutral-600">offline</span>
          )}
        </span>
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ legacy

/**
 * Legacy connector (no scope): the old drill-in — the agent row expands into
 * its session list plus the "new session" affordance.
 */
function LegacyAgentEntry({
  agent,
  selected,
  selectedSessionId,
  onSelect,
  onSelectSession,
}: {
  agent: HubAgentInfo;
  selected: boolean;
  selectedSessionId: string | null;
  onSelect: () => void;
  onSelectSession: (sessionId: string) => void;
}) {
  const { hubOrigin, token } = useConnection();
  const [creating, setCreating] = useState(false);
  return (
    <div className="border-b border-neutral-800/60">
      <button
        className={`flex min-h-[44px] w-full items-start gap-2 px-3 py-2 text-left hover:bg-neutral-900 active:bg-neutral-800 ${
          selected ? 'bg-neutral-900' : ''
        }`}
        onClick={onSelect}
      >
        <span
          className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-400"
          title={`connected ${relTime(agent.connectedAt)}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-neutral-200">{agent.name}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-400">
              {agent.platform}/{agent.arch}
            </span>
            {agent.version !== undefined ? (
              <span className="rounded bg-neutral-800 px-1 text-[9px] text-neutral-400">
                v{agent.version}
              </span>
            ) : null}
            <span className="text-[9px] text-neutral-600">{relTime(agent.connectedAt)}</span>
          </span>
          {agent.cwd !== undefined ? (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-neutral-600">
              {agent.cwd}
            </span>
          ) : null}
        </span>
      </button>
      {selected ? (
        <div className="px-2 pb-2">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="px-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
              Sessions
            </span>
            <button
              className="min-h-[32px] rounded px-2 py-1 text-[11px] text-sky-400 hover:bg-neutral-800"
              title="Start a new session on this agent"
              onClick={() => {
                setCreating((v) => !v);
              }}
            >
              ＋ New session
            </button>
          </div>
          {creating ? (
            <NewSessionForm
              agent={agent}
              onCreated={(sessionId) => {
                setCreating(false);
                onSelectSession(sessionId);
              }}
              onCancel={() => {
                setCreating(false);
              }}
            />
          ) : null}
          <SessionList
            baseUrl={agentBaseUrl(hubOrigin, agent.agentId)}
            token={token}
            selectedSessionId={selectedSessionId}
            onSelect={onSelectSession}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inline create form: cwd (absolute path ON THE AGENT, prefilled from the
 * roster entry) + optional title. The hub never validates agent-local paths.
 */
function NewSessionForm({
  agent,
  onCreated,
  onCancel,
}: {
  agent: HubAgentInfo;
  onCreated: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const { hubOrigin, token } = useConnection();
  const [cwd, setCwd] = useState(agent.cwd ?? '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (cwd.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createSession({
        baseUrl: agentBaseUrl(hubOrigin, agent.agentId),
        token,
        cwd: cwd.trim(),
        title: title.trim() === '' ? undefined : title.trim(),
      });
      onCreated(created.id);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-2 rounded border border-neutral-800 bg-neutral-950 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        className="mb-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
        placeholder="cwd on the agent machine (absolute)"
        value={cwd}
        onChange={(e) => {
          setCwd(e.target.value);
        }}
      />
      <input
        className="mb-1.5 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-sky-600"
        placeholder="title (optional)"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
        }}
      />
      {error !== null ? (
        <div className="mb-1.5">
          <ErrorLine error={error} />
        </div>
      ) : null}
      <div className="flex gap-1.5">
        <button
          type="submit"
          disabled={busy || cwd.trim() === ''}
          className="rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
