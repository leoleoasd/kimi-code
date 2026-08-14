/**
 * Sessions of the selected agent, grouped by workspace (cwd) with the most
 * recently active group first. The v2 endpoint returns items pre-sorted by
 * `meta.updated_at_desc`; grouping keeps that order inside each bucket.
 */

import { useQuery } from '@tanstack/react-query';

import { fetchSessions, type SessionSummary } from '#/sessions/api';
import { Badge, ErrorLine, relTime } from './ui';

const ACTIVITY_TONES: Record<string, 'green' | 'amber' | 'red' | 'neutral'> = {
  running: 'amber',
  approval: 'amber',
  question: 'amber',
  failed: 'red',
  idle: 'neutral',
};

interface WorkspaceGroup {
  readonly key: string;
  readonly cwd: string | null;
  readonly sessions: readonly SessionSummary[];
  readonly latest: number;
}

function groupByWorkspace(sessions: readonly SessionSummary[]): readonly WorkspaceGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const key = session.workspace.cwd ?? session.workspace.id;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [session]);
    else bucket.push(session);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      cwd: list[0]?.workspace.cwd ?? null,
      sessions: list,
      latest: Math.max(...list.map((s) => s.meta.updatedAt)),
    }))
    .toSorted((a, b) => b.latest - a.latest);
}

export function SessionList({
  baseUrl,
  token,
  selectedSessionId,
  onSelect,
}: {
  baseUrl: string;
  token: string;
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const query = useQuery({
    queryKey: ['sessions', baseUrl],
    queryFn: () => fetchSessions({ baseUrl, token }),
    refetchInterval: 5000,
  });

  if (query.isError) {
    return (
      <div className="m-1">
        <ErrorLine error={query.error} />
      </div>
    );
  }
  const sessions = query.data ?? [];
  if (sessions.length === 0) {
    return (
      <div className="px-2 py-1 text-[11px] text-neutral-600 italic">
        {query.isLoading ? 'Loading sessions…' : 'No sessions yet.'}
      </div>
    );
  }
  return (
    <div>
      {groupByWorkspace(sessions).map((group) => (
        <div key={group.key} className="mb-1">
          <div className="truncate px-2 pt-1 pb-0.5 font-mono text-[10px] text-neutral-600" title={group.key}>
            {group.cwd ?? group.key}
          </div>
          {group.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              onSelect={() => {
                onSelect(session.id);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = session.meta.title ?? session.meta.lastPrompt ?? session.id;
  return (
    <button
      className={`flex min-h-[36px] w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-[12px] hover:bg-neutral-800 active:bg-neutral-700 ${
        selected ? 'bg-sky-950/60 text-sky-200' : 'text-neutral-300'
      }`}
      title={session.id}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {session.activity.status !== 'idle' ? (
        <Badge tone={ACTIVITY_TONES[session.activity.status] ?? 'neutral'}>
          {session.activity.status}
        </Badge>
      ) : null}
      <span className="shrink-0 text-[10px] text-neutral-600">{relTime(session.meta.updatedAt)}</span>
    </button>
  );
}
