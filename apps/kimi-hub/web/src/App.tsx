/**
 * App shell — top bar + session rail + chat pane. Navigation is plain state
 * (no router): the selection is an (agent name, session id) pair, re-resolved
 * against the live hub roster on every refresh because the hub mints a fresh
 * `agentId` per connection. Resolution needs BOTH halves of the pair:
 * same-host connections share the name but are scoped to disjoint sessions,
 * so the live entry must expose the selected session (or be an unscoped
 * legacy connector) — a same-name entry lacking the session is NOT a match
 * (the hub would answer 40302). A selection with no such live entry is
 * OFFLINE: the chat pane stays mounted on the last-seen connection info
 * behind an offline banner until a matching reconnect re-resolves it (the
 * rail renders the same situation as grey offline rows).
 *
 * Layout: `>=1024px` a fixed 280px left rail beside the chat column; below
 * that the chat takes the full viewport and the rail becomes a slide-over
 * drawer (hamburger in the top bar; Esc / scrim tap / entry select closes it;
 * plain CSS transitions honoring prefers-reduced-motion). `h-dvh` + safe-area
 * padding keep the shell glued to the real viewport on iOS.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ChatView } from './components/ChatView';
import { InstallButton } from './components/InstallButton';
import { railKey, SessionRail } from './components/SessionRail';
import { useConnection } from './connection';
import {
  agentBaseUrl,
  fetchHubAgents,
  HUB_AGENTS_QUERY_KEY,
  resolveSelectedAgent,
  type HubAgentInfo,
} from './hub/api';
import {
  askNotificationPermission,
  notificationState,
  showHubNotification,
  type NotificationClickMessage,
} from './hub/notifications';
import { useRosterStream } from './hub/stream';
import { fetchSession, sessionInfoQueryKey } from './sessions/api';

export function App() {
  const { hubOrigin, token, disconnect } = useConnection();
  const queryClient = useQueryClient();
  const roster = useQuery({
    queryKey: HUB_AGENTS_QUERY_KEY,
    queryFn: () => fetchHubAgents({ baseUrl: hubOrigin, token }),
    refetchInterval: 5000,
  });
  // Live roster stream: an overlay on the poll's cache key — connects drop /
  // reconnects land instantly, the 5s poll remains the fallback. Its health
  // drives the top-bar glow dot. It also carries agent-engine user
  // notifications (the NotifyUser tool) → the OS notification center.
  const stream = useRosterStream(queryClient, {
    baseUrl: hubOrigin,
    token,
    onNotify: (notify) => void showHubNotification(notify),
  });
  const [agentName, setAgentName] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notifyPerm, setNotifyPerm] = useState(notificationState);

  // A notification click lands in the SW and is posted back here as a
  // (agentName, sessionId) selection; the boot-time URL carries the same for
  // the no-open-window case.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as Partial<NotificationClickMessage> | undefined;
      if (
        data?.type === 'notification-click' &&
        typeof data.agentName === 'string' &&
        typeof data.sessionId === 'string'
      ) {
        setAgentName(data.agentName);
        setSessionId(data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    const params = new URLSearchParams(window.location.search);
    const focusAgent = params.get('focusAgentName');
    const focusSession = params.get('focusSessionId');
    if (focusAgent !== null && focusAgent !== '' && focusSession !== null && focusSession !== '') {
      setAgentName(focusAgent);
      setSessionId(focusSession);
    }
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, []);

  // Last-seen-online roster, in two shapings of the same data: by NAME for
  // this shell's offline fallback (banner + display info), and by
  // (name, session id) for the rail's offline rows — same-host connections
  // share the name, so a by-name map would let one connection's scoped list
  // overwrite the other's and lose the rows of the first. Both maps are fed
  // from the merged roster cache (5s poll + stream overlay share one key).
  const [lastSeen, setLastSeen] = useState<ReadonlyMap<string, HubAgentInfo>>(new Map());
  const [lastSeenSessions, setLastSeenSessions] = useState<ReadonlyMap<string, HubAgentInfo>>(
    new Map(),
  );
  useEffect(() => {
    const data = roster.data;
    if (data === undefined) return;
    setLastSeen((prev) => {
      const next = new Map(prev);
      for (const agent of data) next.set(agent.name, agent);
      return next;
    });
    setLastSeenSessions((prev) => {
      const next = new Map(prev);
      for (const agent of data) {
        for (const sessionId of agent.scope?.sessions ?? []) {
          next.set(railKey(agent.name, sessionId), agent);
        }
      }
      return next;
    });
  }, [roster.data]);

  const selectedAgent = resolveSelectedAgent(roster.data, agentName, sessionId);
  // Roster known (poll OR stream — same key) and no live entry matching BOTH
  // halves of the selection (name AND session scope).
  const selectedAgentOffline =
    agentName !== null && roster.data !== undefined && selectedAgent === null;
  const displayAgent =
    selectedAgent ?? (agentName !== null ? (lastSeen.get(agentName) ?? null) : null);
  const selectedBaseUrl =
    displayAgent !== null ? agentBaseUrl(hubOrigin, displayAgent.agentId) : null;

  // Mobile top-bar title: shares the open chat header's query key, so one
  // `session.meta.updated` invalidation flips both.
  const mobileTitle = useQuery({
    queryKey: sessionInfoQueryKey(selectedBaseUrl ?? '', sessionId ?? ''),
    queryFn: () =>
      // `enabled` guards the null case; the casts just satisfy the queryFn closure.
      fetchSession({ baseUrl: selectedBaseUrl ?? '', token, sessionId: sessionId ?? '' }),
    enabled: selectedBaseUrl !== null && sessionId !== null,
  });

  // Esc closes the drawer (scrim tap and entry-select do too).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  const rail = (
    <SessionRail
      roster={roster}
      lastSeenSessions={lastSeenSessions}
      selectedAgentName={agentName}
      onSelectAgent={setAgentName}
      selectedSessionId={sessionId}
      onSelectSession={(name, id) => {
        setAgentName(name);
        setSessionId(id);
        setDrawerOpen(false);
      }}
    />
  );

  return (
    <div className="flex h-dvh flex-col">
      {/* ------------------------------------------------------ top bar */}
      <header className="flex min-h-12 items-center gap-2 border-b border-neutral-800 px-3 pt-[env(safe-area-inset-top)] lg:px-4">
        <button
          className="-ml-1 flex min-h-[40px] min-w-[40px] items-center justify-center rounded text-neutral-300 hover:bg-neutral-800 lg:hidden"
          aria-label="Open sessions"
          aria-expanded={drawerOpen}
          onClick={() => {
            setDrawerOpen(true);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <path d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>

        {/* Mobile: the open session's title. Desktop: hub id + selection. */}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-100 lg:hidden">
          {sessionId !== null
            ? (mobileTitle.data?.title ??
              mobileTitle.data?.lastPrompt ??
              `${agentName ?? ''} / ${sessionId.slice(0, 8)}…`)
            : 'Kimi Hub'}
        </span>
        <span className="hidden min-w-0 items-center gap-2 lg:flex">
          <span className="text-[13px] font-semibold text-neutral-100">Kimi Hub</span>
          <span className="text-[10px] text-neutral-600" title={hubOrigin}>
            {hubOrigin.replace(/^https?:\/\//, '')}
          </span>
          {displayAgent !== null && sessionId !== null ? (
            <span className="truncate text-[10px] text-neutral-500">
              {displayAgent.name} / {sessionId.slice(0, 8)}…
            </span>
          ) : null}
        </span>

        <span
          className={`ml-auto inline-block h-2 w-2 shrink-0 rounded-full ${
            stream.online ? 'bg-emerald-400' : 'bg-amber-500/70'
          }`}
          title={
            stream.online
              ? 'live roster stream connected'
              : 'roster stream disconnected — falling back to the 5s poll'
          }
        />
        {notifyPerm === 'prompt-needed' ? (
          <button
            className="min-h-[36px] rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
            title="enable OS notifications for agent alerts (the NotifyUser tool)"
            onClick={() => {
              void askNotificationPermission().then(setNotifyPerm);
            }}
          >
            🔔 Enable alerts
          </button>
        ) : null}
        <InstallButton />
        <button
          className="min-h-[36px] rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
          onClick={disconnect}
        >
          Disconnect
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------ desktop rail */}
        <aside className="hidden w-[280px] shrink-0 border-r border-neutral-800 lg:block">
          {rail}
        </aside>

        {displayAgent !== null && sessionId !== null && selectedBaseUrl !== null ? (
          <ChatView
            key={`${displayAgent.agentId}:${sessionId}`}
            baseUrl={selectedBaseUrl}
            token={token}
            sessionId={sessionId}
            agentOffline={selectedAgentOffline}
            agentName={displayAgent.name}
            onSessionMetaUpdated={(meta) => {
              // kap-server fans `session.meta.updated` out on the WS with no
              // subscription (a TUI /rename lands here live): refresh the
              // session-title queries of that (agent, session) — the open
              // chat's header AND every mounted rail row share this key.
              void queryClient.invalidateQueries({
                queryKey: sessionInfoQueryKey(selectedBaseUrl, meta.sessionId),
              });
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="text-center">
              <div className="text-sm text-neutral-500">Select a session to open its chat.</div>
              <div className="mt-1 text-[11px] text-neutral-700">
                <span className="lg:hidden">Tap the ☰ menu for the session list.</span>
                <span className="hidden lg:inline">
                  Connected agents expose their remote sessions in the rail on the left.
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------ mobile drawer */}
      <div
        className={`fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 lg:hidden ${
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden
        onClick={() => {
          setDrawerOpen(false);
        }}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[280px] max-w-[85vw] border-r border-neutral-800 bg-[#0e1116] shadow-2xl transition-transform duration-200 ease-out lg:hidden ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-hidden={!drawerOpen}
      >
        <div className="flex h-full flex-col pl-[env(safe-area-inset-left)]">
          <div className="flex min-h-12 items-center justify-between border-b border-neutral-800 px-3 pt-[env(safe-area-inset-top)]">
            <span className="text-[13px] font-semibold text-neutral-100">Kimi Hub</span>
            <button
              className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded text-neutral-400 hover:bg-neutral-800"
              aria-label="Close sessions"
              onClick={() => {
                setDrawerOpen(false);
              }}
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1">{rail}</div>
        </div>
      </aside>
    </div>
  );
}
