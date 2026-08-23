/**
 * Main pane — the conversation of the selected (agent, session): transcript
 * rendering (via the REST+WS channel), per-agent tabs when the session has
 * subagents, the pending-interaction surfaces, the status strip, and the
 * composer. Rendering consumes the transcript data model types only.
 *
 * Streaming: the channel subscribes at 'delta' grade, so text/thinking frames
 * GROW in place — `frame.text` is the cumulative string and a plain React
 * re-render paints the increment (no per-character effects). The trailing
 * frame of a running turn+step carries a blinking caret.
 *
 * Scrolling: pin-follow. While the viewport sits at the tail the view
 * follows growth — streaming text keeps the tail pinned. Any upward scroll
 * (dy < 0 — wheel / trackpad / touch / keys / scrollbar, one signal for all)
 * drops the pin and growth never re-grabs the viewport; the pin re-arms ONLY
 * by scrolling all the way back to the tail (dist ≤ 4px) or by the "↓
 * latest" pill — a small nudge downward from anywhere never glues it back.
 * Session/tab entry, a LOCAL user-send, and the pill snap to the tail and
 * converge through a bounded settle window (content-visibility rows start as
 * 200px estimates, fonts/images reflow, scroll-anchoring nudges back — a
 * one-shot snap lands on the estimated bottom), with any upward scroll
 * killing the retries.
 * Older history loads lazily in the other direction: the initial paint is
 * one page of turns and an IntersectionObserver sentinel 3000px above the
 * top lines prefetches earlier pages (only while the tail is unpinned, so
 * opening a session stays one page), restoring the viewport by its distance
 * from the bottom so prepends never yank what you're reading; a fetch
 * failure parks a retry button until cleared.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type NoticeFrame,
  type ToolCallFrame,
  type TranscriptAttachment,
  type TranscriptFrame,
  type TranscriptItem,
  type TranscriptMarker,
  type TurnState,
} from '@moonshot-ai/transcript';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { fetchTranscriptPage, TRANSCRIPT_PAGE_SIZE } from '#/transcript/api';
import { oldestTurnId } from '#/transcript/store';
import { useTranscriptChannel } from '#/transcript/channel';
import type { SessionMetaUpdated } from '#/transcript/ws';
import {
  abortQueuedPrompt,
  abortSession,
  fetchModels,
  fetchPromptQueue,
  fetchSession,
  fetchSessionCommands,
  fetchSessionPlans,
  fetchSessionStatus,
  sendPrompt,
  sessionInfoQueryKey,
  setSessionModel,
  undoSession,
} from '#/sessions/api';
import { sendPromptWithImages, buildBlobPreviewUrl, buildImagePreviewUrl, buildSessionMediaPreviewUrl, revokePreviewUrl, type UploadedImage } from '#/sessions/files';
import {
  lastAssistantText,
  runComposerCommand,
  type ComposerAction,
} from '#/sessions/commands';
import { ApprovalsBar } from './ApprovalsBar';
import { Composer, planComposerKey } from './Composer';
import { resolveExitPlanDisplay, type ExitPlanDisplay } from './exit-plan-mode';
import { HubMessageCard, readHubFromOrigin } from './hubMessage';
import { Markdown } from './Markdown';
import { appendQueuedEntry, PromptQueueStrip } from './PromptQueueStrip';
import {
  parseShellInput,
  parseShellOutput,
  shellCommandInfo,
  type ShellCommandOrigin,
} from './shellCommand';
import { TodoListPanel } from './TodoListPanel';
import { QuestionsCard } from './QuestionsCard';
import { ThinkingFrame } from './ThinkingFrame';
import { buildPlanByMarker, collapseMarkerRuns, compactionInProgress, markerLabel, type PlanMarkerContent } from './markers';
import { ActionButton, Badge, Banner, ErrorLine, JsonView, relTime } from './ui';

/**
 * Narrow the Agent tool frame's `subagent_stream` progress (set by the
 * kap-server projector while a foreground subagent runs) into render data.
 */
function readSubagentStreamProgress(progress: {
  text?: string;
  customData?: unknown;
}): { text: string; channel: 'thinking' | 'text'; subagentName?: string } | undefined {
  if (progress.text === undefined || progress.text.trim() === '') return undefined;
  const data = progress.customData as { channel?: unknown; subagentName?: unknown } | undefined;
  return {
    text: progress.text,
    channel: data?.channel === 'thinking' ? 'thinking' : 'text',
    subagentName: typeof data?.subagentName === 'string' ? data.subagentName : undefined,
  };
}

export function ChatView({
  baseUrl,
  token,
  sessionId,
  agentOffline,
  agentName: _agentName,
  onSessionMetaUpdated,
}: {
  /** The agent's proxy base (`${hubOrigin}/agents/{agentId}`). */
  baseUrl: string;
  token: string;
  sessionId: string;
  /**
   * The selected agent fell out of the live roster: the pane stays mounted on
   * its last-seen connection info behind an offline banner; a same-name
   * reconnect re-resolves (and remounts) it.
   */
  agentOffline?: boolean;
  /** The agent's display name — goes into OS notification bodies. */
  agentName?: string;
  /** Global WS meta frames (rename / auto-title) — stamped with this (agent, session)'s cache. */
  onSessionMetaUpdated: (meta: SessionMetaUpdated) => void;
}) {
  const [transcriptAgentId, setTranscriptAgentId] = useState('main');
  const [viewError, setViewError] = useState<unknown>(null);
  /** Completion text of the last composer slash command (the chat area's notice line). */
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Single content wrapper inside the scroll box — observed for growth (jump pill). */
  const contentRef = useRef<HTMLDivElement>(null);
  /** In-flight settle retries of the last snap (rAF + timeout ids). */
  const snapRetriesRef = useRef<number[]>([]);
  /** Newer content sits off-screen — shows the "↓ latest" pill. */
  const [showJump, setShowJump] = useState(false);
  /**
   * Pin-follow: while true, transcript/late-layout growth re-lands on the
   * tail. Set on entry/send/pill snap; an upward scroll (dy < 0, any device)
   * drops it permanently; a scroll landing within 4px of the tail — and
   * nothing else — re-arms it.
   */
  const pinnedRef = useRef(true);
  /** Last observed scrollTop — onScroll derives the scroll direction from it. */
  const lastScrollTopRef = useRef(0);
  const queryClient = useQueryClient();

  const { store, state, agents, loaded, loadError } = useTranscriptChannel(
    baseUrl,
    token,
    sessionId,
    transcriptAgentId,
    { onSessionMetaUpdated },
  );
  const items = state.items;
  const compacting = compactionInProgress(items);

  // The header title shares the rail's session-info key: one WS-driven
  // invalidation at the App level flips both in real time.
  const info = useQuery({
    queryKey: sessionInfoQueryKey(baseUrl, sessionId),
    queryFn: () => fetchSession({ baseUrl, token, sessionId }),
  });

  const status = useQuery({
    queryKey: ['status', baseUrl, sessionId],
    queryFn: () => fetchSessionStatus({ baseUrl, token, sessionId }),
    refetchInterval: 3000,
  });
  const running =
    status.data?.busy === true ||
    state.meta.activity === 'turn' ||
    items.some((item) => item.kind === 'turn' && item.state === 'running');

  // The engine-owned prompt queue (active turn + FIFO) feeding the strip,
  // keyed per viewed agent: queues live on agents, not sessions, so the
  // subagent tab shows the subagent's own queue (the web composer still only
  // writes to main — same targeting as before).
  // ChatView mounts ONLY for the selected (agent, session) and unmounts on
  // deselect, so this 2s poll never runs for idle background sessions.
  const queueQueryKey = useMemo(
    () => ['promptQueue', baseUrl, sessionId, transcriptAgentId] as const,
    [baseUrl, sessionId, transcriptAgentId],
  );
  const queue = useQuery({
    queryKey: queueQueryKey,
    queryFn: () => fetchPromptQueue({ baseUrl, token, sessionId, agentId: transcriptAgentId }),
    refetchInterval: 2000,
    enabled: sessionId !== '',
  });

  // OS-level notifications are owned by the CONNECTOR (engine → tunnel → hub
  // → Web Push): every connected session pings even when no chat page is
  // open, so the page adds nothing here (the spirit of the push chain is
  // "wake the device whose page isn't watching").

  // Plan contents for both plan surfaces (`plan.revision` markers and
  // ExitPlanMode tool frames): the markers carry only blob references and
  // plan-file-mode args carry no plan, so the server-side recovery route
  // projects the actual plan text per ExitPlanMode call; markers pair by
  // markerId, tool frames by toolCallId. The query re-runs when a new
  // revision marker or call arrives; it stays enabled in sessions without
  // `plan.revision` markers as long as an ExitPlanMode frame exists. Both
  // counts share one memoized scan — a plain per-render reduce over every
  // frame was a phone jank source at long loaded histories.
  const { planRevisionCount, exitPlanCallCount } = useMemo(() => {
    let revisionCount = 0;
    let exitCallCount = 0;
    for (const item of items) {
      if (item.kind === 'marker') {
        if (item.marker === 'plan.revision') revisionCount += 1;
        continue;
      }
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind === 'tool' && frame.name === 'ExitPlanMode') exitCallCount += 1;
        }
      }
    }
    return { planRevisionCount: revisionCount, exitPlanCallCount: exitCallCount };
  }, [items]);
  const plans = useQuery({
    queryKey: ['session-plans', baseUrl, sessionId, transcriptAgentId, planRevisionCount, exitPlanCallCount],
    queryFn: () => fetchSessionPlans({ baseUrl, token, sessionId, agentId: transcriptAgentId }),
    enabled: planRevisionCount + exitPlanCallCount > 0 && sessionId !== '',
  });
  const planByMarkerId = useMemo(
    () => buildPlanByMarker(items, plans.data ?? []),
    [items, plans.data],
  );
  const planByToolCallId = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of plans.data ?? []) map.set(entry.toolCallId, entry.plan);
    return map;
  }, [plans.data]);

  // Both abort paths invalidate the queue query — the 2s poll would settle
  // on its own; this is a promptness nicety (the abort's drain freebie shows
  // the next queued prompt promoting within a tick).
  const abortTurn = async (): Promise<void> => {
    await abortSession({ baseUrl, token, sessionId });
    await queryClient.invalidateQueries({ queryKey: queueQueryKey });
  };

  const abortQueued = async (promptId: string): Promise<void> => {
    await abortQueuedPrompt({ baseUrl, token, sessionId, promptId, agentId: transcriptAgentId });
    await queryClient.invalidateQueries({ queryKey: queueQueryKey });
  };

  // Queue-strip chip click = edit: drop the entry AND hand its text to the
  // composer (the TUI's recall-last-queued). The nonce makes every recall a
  // distinct request even when the text repeats.
  const [recallDraft, setRecallDraft] = useState<{ text: string; nonce: number } | null>(null);
  const recallNonceRef = useRef(0);
  const recallQueued = async (promptId: string, text: string): Promise<void> => {
    await abortQueuedPrompt({ baseUrl, token, sessionId, promptId, agentId: transcriptAgentId });
    await queryClient.invalidateQueries({ queryKey: queueQueryKey });
    if (text.trim() !== '') {
      recallNonceRef.current += 1;
      setRecallDraft({ text, nonce: recallNonceRef.current });
    }
  };

  // Per-message rollback: the engine cuts by the count of trailing prompts
  // (`:undo { count }`), so the clicked user turn maps to its ordinal from
  // the end. Turn-view confirm is per-bubble; the transcript resyncs itself
  // off the undo's context splice ops — the extra invalidations are a
  // promptness nicety for queue/status. Memoized: ItemView memoization hinges
  // on reference stability between item-level updates.
  const rollbackCounts = useMemo(() => rollbackCountsForItems(items), [items]);
  const rollbackTurn = async (turnId: string): Promise<void> => {
    const count = rollbackCounts.get(turnId);
    if (count === undefined) return;
    await undoSession({ baseUrl, token, sessionId, count });
    setCommandNotice(`rolled back the last ${String(count)} prompt${count === 1 ? '' : 's'}`);
    await queryClient.invalidateQueries({ queryKey: queueQueryKey });
    await queryClient.invalidateQueries({ queryKey: ['status', baseUrl, sessionId] });
  };
  // Stable rollback entrypoint for the memoized rows: latest logic via ref,
  // one identity forever.
  const rollbackTurnRef = useRef(rollbackTurn);
  rollbackTurnRef.current = rollbackTurn;
  const handleRollback = useCallback((turnId: string): void => {
    void rollbackTurnRef.current(turnId).catch(setViewError);
  }, []);

  // One position check is the source of truth for the jump pill across the
  // scroll / items / resize paths: newer content within ~80px of the tail
  // counts as "caught up".
  const syncJumpPill = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
  }, []);

  // Growth: pinned → keep the tail in view (streaming text follows); not
  // pinned → leave the viewport alone and only keep the jump pill truthful.
  // Gated on `loaded` — until then the entry snap below owns the position.
  useLayoutEffect(() => {
    if (!loaded) return;
    if (pinnedRef.current) {
      const el = scrollRef.current;
      if (el !== null) el.scrollTop = el.scrollHeight;
    }
    syncJumpPill();
  }, [loaded, items, syncJumpPill]);

  /** Kill the settle retries of an in-flight snap (new snap / user scrolls / unmount). */
  const cancelSnapRetries = useCallback(() => {
    for (const id of snapRetriesRef.current) {
      cancelAnimationFrame(id);
      window.clearTimeout(id);
    }
    snapRetriesRef.current = [];
  }, []);

  /**
   * Jump to the tail, then keep re-landing through a bounded settle window:
   * content-visibility rows refine from 200px estimates to real heights as
   * they render, fonts/images reflow, and scroll-anchoring nudges the
   * position back — a one-shot snap lands on the ESTIMATED bottom and stays
   * stranded above the real tail. Finite retries converge a USER-requested
   * jump; they are not a follow (max ~1.2s, and any user scroll kills them).
   */
  const snapToBottom = useCallback(() => {
    cancelSnapRetries();
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
    const timers = snapRetriesRef.current;
    let frames = 0;
    const again = () => {
      el.scrollTop = el.scrollHeight;
      frames += 1;
      if (frames < 12) timers.push(requestAnimationFrame(again));
    };
    timers.push(requestAnimationFrame(again));
    for (const ms of [250, 600, 1200]) {
      timers.push(
        window.setTimeout(() => {
          el.scrollTop = el.scrollHeight;
        }, ms),
      );
    }
  }, [cancelSnapRetries]);

  // Session entry: land at the tail as soon as the initial page (or a
  // switched agent tab) has painted. `loaded` only flips false → true once
  // per (session, tab) mount, so this never yanks the view away from someone
  // scrolling an open conversation.
  useLayoutEffect(() => {
    if (!loaded) return;
    snapToBottom();
  }, [loaded, snapToBottom]);

  // Late growth the transcript never sees (attachment/image loads, markdown
  // reflow, header/composer/window resizes): pinned keeps the tail, otherwise
  // just keep the jump pill truthful.
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (scroll === null || content === null) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scroll.scrollTop = scroll.scrollHeight;
      syncJumpPill();
    });
    observer.observe(content);
    observer.observe(scroll);
    return () => {
      observer.disconnect();
    };
  }, [syncJumpPill]);

  /**
   * The whole pin state machine, in one scroll handler:
   *   dy < 0 (moving AWAY from the tail, whatever the input device — wheel /
   *     trackpad / touch / keys / scrollbar all funnel into it) drops the pin
   *     and any settling snap, instantly and permanently;
   *   landing within 4px of the tail re-arms it — and NOTHING else does. No
   *   down-drift meters, no zones: a small nudge downward from anywhere must
   *   never glue the view back (only really reaching the bottom may).
   */
  const onScroll = () => {
    const el = scrollRef.current;
    if (el !== null) {
      const y = el.scrollTop;
      const dy = y - lastScrollTopRef.current;
      lastScrollTopRef.current = y;
      if (dy < 0) {
        if (pinnedRef.current) pinnedRef.current = false;
        cancelSnapRetries();
      } else if (el.scrollHeight - y - el.clientHeight <= 4) {
        pinnedRef.current = true;
      }
    }
    syncJumpPill();
  };

  // Infinite top-loading: a top sentinel (IntersectionObserver, 3000px early
  // margin — several phone screens, so a page is usually in hand BEFORE the
  // user scrolls into it) pages the previous 10 turns in as the user scrolls
  // up. Prefetching is gated on `!pinnedRef`: at the bottom (entry / "↓
  // latest") history stays unfetched — the whole point of the small initial
  // page is fast entry. The invariant preserved across a prepend is the
  // distance-from-bottom of the viewport — captured AT APPLY TIME (the fetch
  // takes hundreds of ms on a phone, all of it user-scroll time; recording
  // the anchor at fetch time restored to a stale spot and teleported the
  // viewport), restored in the layout effect keyed on `items`.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const loadingOlderRef = useRef(false);
  /** Pre-pend anchor: `distanceFromBottom` recorded right before the page merges. */
  const olderAnchorRef = useRef<{ distanceFromBottom: number } | null>(null);
  const olderSentinelRef = useRef<HTMLDivElement>(null);

  const loadOlder = useCallback(async () => {
    if (store === null || loadingOlderRef.current || !state.hasMoreOlder) return;
    const oldest = oldestTurnId(items);
    if (oldest === undefined) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await fetchTranscriptPage({
        baseUrl,
        token,
        sessionId,
        agentId: transcriptAgentId,
        beforeTurn: oldest,
        pageSize: TRANSCRIPT_PAGE_SIZE,
      });
      const el = scrollRef.current;
      if (el !== null) {
        olderAnchorRef.current = { distanceFromBottom: el.scrollHeight - el.scrollTop };
      }
      const stateBefore = store.getState();
      store.applyPage(page);
      if (store.getState() === stateBefore) {
        // applyPage merged nothing (already at the top of history): there is
        // no items change and no layout effect — never let a stale anchor get
        // consumed by a later, unrelated update.
        olderAnchorRef.current = null;
      }
      setOlderError(null);
    } catch (error) {
      olderAnchorRef.current = null;
      setOlderError(error);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [store, items, state.hasMoreOlder, baseUrl, token, sessionId, transcriptAgentId]);

  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    if (anchor === null) return;
    olderAnchorRef.current = null;
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight - anchor.distanceFromBottom;
  }, [items]);

  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const root = scrollRef.current;
    if (sentinel === null || root === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // Only fetch ahead while the user is actually browsing history — at
        // the pinned tail (entry / "↓ latest") loading older pages would
        // just re-inflate the transcript we deliberately entered small.
        if (!pinnedRef.current) void loadOlder();
      },
      { root, rootMargin: '3000px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [loadOlder, loaded, state.hasMoreOlder]);

  // Composer slash commands — `/…` lines forward to the agent's command
  // bridge (the connected TUI's OWN dispatch; sessions/commands.ts keeps no
  // second grammar); `/copy` + `/export-debug-zip` run browser-locally. The
  // returned text goes to the chat area's notice line below. The status
  // strip's 3s poll would catch up on its own, so the explicit invalidation
  // below is a promptness nicety, not a correctness need; session mutations
  // (compact/undo/fork/btw) surface through the normal resync/refresh path.
  const runCommand = async (action: ComposerAction): Promise<void> => {
    setCommandNotice(null);
    const result = await runComposerCommand(action, {
      baseUrl,
      token,
      sessionId,
      getLastAssistantText: () => lastAssistantText(state.items),
    });
    setCommandNotice(result.notice === '' ? null : result.notice);
    await queryClient.invalidateQueries({ queryKey: ['status', baseUrl, sessionId] });
  };

  // The hint popover's command pool — the agent's registry when bridged (the
  // TUI's own list); query failures (headless agent) degrade to the local pair.
  const commandCatalog = useQuery({
    queryKey: ['session-commands', baseUrl, sessionId],
    queryFn: () => fetchSessionCommands({ baseUrl, token, sessionId }),
    retry: false,
  });

  // The model dropdown: catalog is agent-wide (`GET /models`), the current
  // value rides the status poll; a selection persists at the engine profile
  // (`POST …/profile agent_config.model`) and the status refetch shows it.
  const models = useQuery({
    queryKey: ['agent-models', baseUrl],
    queryFn: () => fetchModels({ baseUrl, token }),
    retry: false,
    staleTime: 60_000,
  });
  const [modelSaving, setModelSaving] = useState(false);
  /** Header dropdown AND the `/model` popup: model + optional thinking effort in one profile write. */
  const saveModel = async (model: string, thinking?: string): Promise<void> => {
    setModelSaving(true);
    try {
      await setSessionModel({ baseUrl, token, sessionId, model, thinking });
      await queryClient.invalidateQueries({ queryKey: ['status', baseUrl, sessionId] });
    } finally {
      setModelSaving(false);
    }
  };

  const submitPrompt = async (
    text: string,
    images: readonly UploadedImage[],
  ): Promise<{ status: 'running' | 'queued' | 'blocked' }> => {
    // The plain-text path keeps the exact pre-images request (sendPrompt in
    // sessions/api.ts); attachments route through the multi-part body.
    const result =
      images.length === 0
        ? await sendPrompt({ baseUrl, token, sessionId, text })
        : await sendPromptWithImages({ baseUrl, token, sessionId, text, images });
    // The LOCAL USER just spoke — the one growth-adjacent scroll besides the
    // pill: land on their fresh turn (model output itself never scrolls).
    snapToBottom();
    // Optimistic chip: the queue poll replays the same item authoritatively
    // — nothing needs to be carried until then. Never let this nicety fail
    // the send UX (the REST already succeeded). Composed prompts always land
    // on the MAIN agent's queue — key the chip there, not to the viewed tab.
    if (result.status === 'queued') {
      try {
        queryClient.setQueryData(
          ['promptQueue', baseUrl, sessionId, 'main'],
          (old: { readonly active: unknown; readonly queued?: readonly unknown[] } | undefined) =>
            appendQueuedEntry(
              old as Parameters<typeof appendQueuedEntry>[0],
              { promptId: result.promptId, status: 'queued', text },
            ),
        );
      } catch {
        // the 2s poll corrects the strip
      }
    }
    return result;
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // TUI parity: Esc anywhere inside the pane aborts the running turn
        // (the draft keeps its text). The composer's own Esc branch stops
        // propagation when it fires; mid-IME Esc noops via planComposerKey.
        if (
          planComposerKey({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
            busy: running,
          }) === 'abort-turn'
        ) {
          e.preventDefault();
          void abortTurn().catch(setViewError);
        }
      }}
    >
      {/* ------------------------------------------------ header strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2 lg:px-4">
        <span className="max-w-full truncate font-mono text-[11px] text-neutral-400" title={sessionId}>
          session {info.data?.title ?? info.data?.lastPrompt ?? `${sessionId.slice(0, 8)}…`}
        </span>
        {agents.length > 1 ? (
          // Agent pills: single line, bounded, scrollable — a long task label
          // must never inflate the header into a wall of pre-sized cards.
          <div className="flex min-w-0 max-w-full gap-1 overflow-x-auto">
            {agents.map((descriptor) => (
              <button
                key={descriptor.agentId}
                className={`max-w-[11rem] shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  descriptor.agentId === transcriptAgentId
                    ? 'bg-sky-900/60 text-sky-300'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
                title={
                  descriptor.type !== undefined
                    ? `${descriptor.type}${descriptor.label !== undefined ? ` · ${descriptor.label}` : ''}`
                    : descriptor.label
                }
                onClick={() => {
                  setTranscriptAgentId(descriptor.agentId);
                }}
              >
                {descriptor.agentId === 'main' ? 'main' : (descriptor.label ?? descriptor.agentId)}
              </button>
            ))}
          </div>
        ) : (
          <Badge tone="sky">agent: {transcriptAgentId}</Badge>
        )}
        {running ? <Badge tone="amber">busy</Badge> : <Badge tone="green">idle</Badge>}
        {status.data?.permission !== undefined && status.data.permission !== 'default' ? (
          <Badge tone={status.data.permission === 'yolo' ? 'red' : 'sky'}>
            {status.data.permission}
          </Badge>
        ) : null}
        {status.data?.planMode === true ? <Badge tone="amber">plan</Badge> : null}
        {status.data?.swarmMode === true ? <Badge tone="violet">swarm</Badge> : null}
        {compacting ? <Badge tone="amber">compacting context…</Badge> : null}
        {state.meta.goal !== undefined && state.meta.goal.status !== 'complete' ? (
          <Badge tone="green" title={state.meta.goal.objective}>
            goal: {state.meta.goal.status}
          </Badge>
        ) : null}
        {status.data !== undefined ? (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-neutral-600">
            {models.data !== undefined && models.data.length > 0 ? (
              <select
                aria-label="model"
                title="switch model"
                value={status.data.model ?? ''}
                disabled={modelSaving}
                className="max-w-[9rem] rounded border border-neutral-800 bg-neutral-900 px-1 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-700 disabled:opacity-50"
                onChange={(e) => {
                  void saveModel(e.target.value).catch(setViewError);
                }}
              >
                {status.data.model === undefined || status.data.model === '' ? (
                  <option value="" disabled>
                    model…
                  </option>
                ) : null}
                {models.data.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
                {status.data.model !== undefined &&
                status.data.model !== '' &&
                !models.data.some((choice) => choice.id === status.data.model) ? (
                  // An alias the catalog doesn't list (renamed/foreign config):
                  // still offer it so the select can display the live value.
                  <option value={status.data.model}>{status.data.model}</option>
                ) : null}
              </select>
            ) : (
              <span>{status.data.model ?? ''}</span>
            )}
            {status.data.maxContextTokens !== undefined
              ? `ctx ${Math.round(status.data.contextUsage * 100)}%`
              : ''}
          </span>
        ) : null}
        {status.isError ? <Badge tone="red">status: {shortError(status.error)}</Badge> : null}
        <ActionButton
          title="reload the session and apply config.toml + tui.toml — same as the TUI's /reload (picks up mcp.json and plugin changes); idle-only"
          disabled={running}
          onClick={() => runCommand({ kind: 'remote', input: '/reload' }).catch(setViewError)}
        >
          Reload
        </ActionButton>
        {running ? (
          <ActionButton danger onClick={() => abortTurn().catch(setViewError)}>
            Abort
          </ActionButton>
        ) : null}
      </div>

      {/* ------------------------------------------------ offline banner */}
      {agentOffline === true ? (
        <Banner>agent offline — the remote side disconnected; reconnects pick the session back up</Banner>
      ) : null}

      {/* ------------------------------------------------ message scroll */}
      <div className="relative min-h-0 flex-1">
        <div
          className="h-full overflow-y-auto px-3 py-3 lg:px-4"
          ref={scrollRef}
          onScroll={onScroll}
        >
          <div ref={contentRef}>
            {loadError !== null ? (
              <div className="mb-2">
                <ErrorLine error={loadError} />
              </div>
            ) : null}
            {viewError !== null ? (
              <div className="mb-2">
                <ErrorLine error={viewError} />
              </div>
            ) : null}
            {state.hasMoreOlder ? (
              <div className="mb-3 flex justify-center py-1" ref={olderSentinelRef}>
                {olderError !== null ? (
                  <ActionButton
                    onClick={() => {
                      setOlderError(null);
                      void loadOlder();
                    }}
                  >
                    Retry loading earlier turns
                  </ActionButton>
                ) : loadingOlder ? (
                  <span className="text-[11px] text-neutral-600">loading earlier turns…</span>
                ) : null}
              </div>
            ) : null}
            {items.length === 0 ? (
              <div className="mt-8 text-center text-[12px] text-neutral-600 italic">
                {loaded || loadError !== null
                  ? 'Empty session — send a prompt below.'
                  : 'Loading transcript…'}
              </div>
            ) : (
              <ItemList
                items={items}
                attachments={state.attachments}
                rollbackCounts={transcriptAgentId === 'main' ? rollbackCounts : undefined}
                onRollback={handleRollback}
                planByMarkerId={planByMarkerId}
                planByToolCallId={planByToolCallId}
                baseUrl={baseUrl}
                token={token}
                sessionId={sessionId}
                agentId={transcriptAgentId}
              />
            )}
            {/* Slash-command completion line — the neutral NoticeFrame grammar. */}
            {commandNotice !== null ? (
              <div className="mb-2 max-w-full rounded bg-neutral-900/60 px-3 py-1.5 text-[11px] break-words text-neutral-400 sm:max-w-[92%]">
                {commandNotice}
              </div>
            ) : null}
          </div>
        </div>
        {showJump ? (
          <button
            className="absolute right-3 bottom-3 rounded-full border border-neutral-700 bg-neutral-900/95 px-2.5 py-1.5 text-[11px] text-neutral-300 shadow-lg hover:bg-neutral-800"
            onClick={snapToBottom}
          >
            ↓ latest
          </button>
        ) : null}
      </div>

      {/* ------------------------------------------------ interactions + composer */}
      <ApprovalsBar baseUrl={baseUrl} token={token} sessionId={sessionId} active={running} />
      <QuestionsCard baseUrl={baseUrl} token={token} sessionId={sessionId} active={running} />
      <PromptQueueStrip
        queue={queue.data}
        onAbortQueued={(promptId) => void abortQueued(promptId).catch(setViewError)}
        onRecallQueued={(promptId, text) => void recallQueued(promptId, text).catch(setViewError)}
      />
      <TodoListPanel todos={state.todos} />
      <Composer
        busy={running}
        baseUrl={baseUrl}
        token={token}
        commandCatalog={commandCatalog.data ?? []}
        modelPicker={
          models.data !== undefined && models.data.length > 0
            ? {
                models: models.data,
                currentModel: status.data?.model,
                currentEffort: status.data?.thinkingLevel,
                saving: modelSaving,
                onApply: saveModel,
              }
            : undefined
        }
        onSend={submitPrompt}
        onAbort={abortTurn}
        onCommand={runCommand}
        draftRequest={recallDraft}
      />
    </div>
  );
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 60) : 'error';
}

/**
 * turnId → undo-count: how many conversation prompts the engine must cut to
 * roll back to BEFORE that user turn. Only user-origin, non-queued turns are
 * anchors (mirrors the engine's `isUndoAnchor`: skill/plugin activations it
 * counts never appear as user turns, so a boundary click under-cuts rather
 * than over-cuts). The tail of `items` is complete (windowing cuts the
 * FRONT), so counting from the end is exact for the loaded view.
 */
export function rollbackCountsForItems(items: readonly TranscriptItem[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let count = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item === undefined || item.kind !== 'turn') continue;
    if (item.origin.kind !== 'user' || item.state === 'queued') continue;
    // Shell blocks fold into user-kind turns but are not engine undo anchors
    // (matches the engine's `isUndoAnchor`).
    if ((item.origin.payload as { kind?: unknown } | undefined)?.kind === 'shell_command') continue;
    count += 1;
    counts.set(item.turnId, count);
  }
  return counts;
}

// ------------------------------------------------------------------ items

const ItemList = memo(function ItemList({
  items,
  attachments,
  rollbackCounts,
  onRollback,
  planByMarkerId,
  planByToolCallId,
  baseUrl,
  token,
  sessionId,
  agentId,
}: {
  items: readonly TranscriptItem[];
  attachments: ReadonlyMap<string, TranscriptAttachment>;
  /** Present only on the main agent's tab (undo cuts the MAIN conversation). */
  rollbackCounts?: ReadonlyMap<string, number>;
  onRollback?: (turnId: string) => void;
  /** `plan.revision` markerId → recovered plan content (TUI PlanBox parity). */
  planByMarkerId?: ReadonlyMap<string, PlanMarkerContent>;
  /** ExitPlanMode toolCallId → recovered plan content (same recovery entries). */
  planByToolCallId?: ReadonlyMap<string, string>;
  baseUrl: string;
  token: string;
  sessionId: string;
  agentId: string;
}) {
  // Conversation rows: bookkeeping markers out, marker/taskref runs collapsed
  // — raw `items` stay the source for turn ordinals/anchors (see callers).
  const rows = useMemo(() => collapseMarkerRuns(items), [items]);
  return (
    <>
      {rows.map((row) => (
        // Native virtual screen: the browser skips layout/paint for
        // off-screen items, so long transcripts stay cheap without a
        // windowing library.
        <div
          key={row.key}
          style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
        >
          <ItemView
            item={row.item}
            repeat={row.repeat}
            attachments={attachments}
            rollbackCount={row.item.kind === 'turn' ? rollbackCounts?.get(row.item.turnId) : undefined}
            onRollback={onRollback}
            planContent={row.item.kind === 'marker' ? planByMarkerId?.get(row.item.markerId) : undefined}
            planByToolCallId={planByToolCallId}
            baseUrl={baseUrl}
            token={token}
            sessionId={sessionId}
            agentId={agentId}
          />
        </div>
      ))}
    </>
  );
});

/**
 * Memoized per item: stream deltas / poll tickles re-render ChatView's whole
 * shell constantly but each transcript item object is referentially stable
 * until its own content moves, so unchanged rows cost zero — on a phone with
 * a few pages mounted this is the difference between smooth and stutter.
 */
const ItemView = memo(function ItemView({
  item,
  repeat,
  attachments,
  rollbackCount,
  onRollback,
  planContent,
  planByToolCallId,
  baseUrl,
  token,
  sessionId,
  agentId,
}: {
  item: TranscriptItem;
  /** Size of the collapsed run this row stands for (1 = a lone item). */
  repeat: number;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
  rollbackCount?: number;
  onRollback?: (turnId: string) => void;
  planContent?: PlanMarkerContent;
  planByToolCallId?: ReadonlyMap<string, string>;
  baseUrl: string;
  token: string;
  sessionId: string;
  agentId: string;
}) {
  switch (item.kind) {
    case 'turn':
      return (
        <TurnView
          turn={item}
          attachments={attachments}
          rollbackCount={rollbackCount}
          onRollback={onRollback}
          planByToolCallId={planByToolCallId}
          baseUrl={baseUrl}
          token={token}
          sessionId={sessionId}
          agentId={agentId}
        />
      );
    case 'marker':
      return <MarkerView marker={item} repeat={repeat} planContent={planContent} />;
    case 'taskref':
      return (
        <div className="mb-2 flex items-center gap-2 text-[10px] text-neutral-600">
          <div className="h-px flex-1 bg-neutral-800" />
          <span className="font-mono">
            task spawned (async work continues in the background)
            {repeat > 1 ? ` ×${repeat}` : ''}
          </span>
          <div className="h-px flex-1 bg-neutral-800" />
        </div>
      );
  }
});

function MarkerView({
  marker,
  repeat,
  planContent,
}: {
  marker: TranscriptMarker;
  repeat: number;
  /** Recovered plan markdown for `plan.revision` rows, when known. */
  planContent?: PlanMarkerContent;
}) {
  // A plan revision with recovered content renders as a real card (TUI
  // PlanBox parity: the plan the review was submitted with), not a divider.
  if (planContent !== undefined) {
    return (
      <div className="mb-3 max-w-full rounded border border-neutral-700/80 bg-neutral-900/40 sm:max-w-[92%]">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-500">
          <span>
            plan revised{planContent.version !== undefined ? ` · v${planContent.version}` : ''}
          </span>
          {marker.at !== undefined ? <span>{relTime(Date.parse(marker.at))}</span> : null}
        </div>
        <div className="px-3 py-2">
          <Markdown text={planContent.plan} />
        </div>
      </div>
    );
  }
  // One divider row only — the payload is an internal blob, never rendered.
  return (
    <div className="mb-3 flex items-center gap-2 text-[10px] text-neutral-600">
      <div className="h-px flex-1 bg-neutral-800" />
      <span>
        {markerLabel(marker.marker, marker.payload)}
        {repeat > 1 ? ` ×${repeat}` : ''}
      </span>
      {marker.at !== undefined ? <span>{relTime(Date.parse(marker.at))}</span> : null}
      <div className="h-px flex-1 bg-neutral-800" />
    </div>
  );
}

function turnStateTone(state: TurnState): 'neutral' | 'green' | 'amber' | 'red' {
  switch (state) {
    case 'running':
      return 'amber';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'queued':
    case 'cancelled':
      return 'neutral';
  }
}

/** The blinking caret pinned after the open tail frame's content. */
function StreamCaret() {
  return (
    <span className="stream-caret" aria-hidden>
      ▍
    </span>
  );
}

function RollbackControl({
  rollbackCount,
  onRollback,
}: {
  rollbackCount?: number;
  onRollback?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (rollbackCount === undefined || onRollback === undefined) return null;
  return confirming ? (
    <span className="mt-1 flex shrink-0 items-center gap-1">
      <button
        className="rounded border border-red-900/70 bg-red-950/60 px-2 py-1 text-[11px] text-red-300"
        onClick={() => {
          setConfirming(false);
          onRollback();
        }}
      >
        Roll back {String(rollbackCount)} prompt{rollbackCount === 1 ? '' : 's'}?
      </button>
      <button
        className="rounded px-1.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-800"
        aria-label="cancel rollback"
        onClick={() => {
          setConfirming(false);
        }}
      >
        ✕
      </button>
    </span>
  ) : (
    <button
      className="mt-1 shrink-0 rounded px-1.5 py-1 text-[12px] text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
      title="roll back to before this message"
      aria-label="roll back to before this message"
      onClick={() => {
        setConfirming(true);
      }}
    >
      ↩
    </button>
  );
}

/**
 * `!` shell-command records render as a terminal card (mirrors the TUI's
 * `$ cmd` echo + raw output panel) instead of the user bubble — the recorded
 * prompt text still carries the `<bash-input>`/`<bash-stdout`/`<bash-stderr>`
 * XML wrapper, which would otherwise show verbatim in the bubble.
 */
function ShellCommandView({
  prompt,
  shell,
  rollbackCount,
  onRollback,
}: {
  prompt: string;
  shell: ShellCommandOrigin;
  rollbackCount?: number;
  onRollback?: () => void;
}) {
  const rollback = (
    <RollbackControl rollbackCount={rollbackCount} onRollback={onRollback} />
  );
  if (shell.phase === 'input') {
    return (
      <div className="mb-2 flex items-start gap-1.5">
        {rollback}
        <div className="max-w-full overflow-x-auto rounded border border-neutral-800 bg-neutral-900/70 px-3 py-1.5 font-mono text-[12px] whitespace-pre-wrap break-all sm:max-w-[92%]">
          <span className="select-none text-emerald-400">$ </span>
          <span className="text-neutral-200">{parseShellInput(prompt)}</span>
        </div>
      </div>
    );
  }
  const { stdout, stderr } = parseShellOutput(prompt);
  const hasOutput = stdout.length > 0 || stderr.length > 0;
  return (
    <div className="mb-2 flex items-start gap-1.5">
      {rollback}
      <div className="max-w-full overflow-x-auto rounded bg-black/40 px-3 py-1.5 font-mono text-[12px] whitespace-pre-wrap break-all sm:max-w-[92%]">
        {hasOutput ? (
          <>
            {stdout.length > 0 ? <div className="text-neutral-300">{stdout}</div> : null}
            {stderr.length > 0 ? (
              <div className={shell.isError ? 'text-red-400' : 'text-neutral-500'}>{stderr}</div>
            ) : null}
          </>
        ) : (
          <span className="text-neutral-600">(no output)</span>
        )}
      </div>
    </div>
  );
}

function TurnView({
  turn,
  attachments,
  rollbackCount,
  onRollback,
  planByToolCallId,
  baseUrl,
  token,
  sessionId,
  agentId,
}: {
  turn: Extract<TranscriptItem, { kind: 'turn' }>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
  /** Undo-count to roll back to before this turn; undefined → no button. */
  rollbackCount?: number;
  onRollback?: (turnId: string) => void;
  planByToolCallId?: ReadonlyMap<string, string>;
  baseUrl: string;
  token: string;
  sessionId: string;
  agentId: string;
}) {
  const isUser = turn.origin.kind === 'user';
  const shell = shellCommandInfo(turn.origin.payload);
  const hubFrom = readHubFromOrigin(turn.origin.payload);
  const mediaItems = (turn.attachmentIds ?? [])
    .map((id) => attachments.get(id))
    .filter((a): a is TranscriptAttachment => a !== undefined);
  // The open tail: while the turn runs, its last running step's last frame is
  // the one appends grow into — it gets the streaming caret.
  const lastStep = turn.steps.at(-1);
  const openTailFrameId =
    turn.state === 'running' && lastStep?.state === 'running'
      ? lastStep.frames.at(-1)?.frameId
      : undefined;
  const hasPrompt = turn.prompt !== undefined && turn.prompt !== '';
  return (
    <div className="mb-3">
      {/* Prompt: shell commands get a terminal card, users a bubble, other
          origins a muted header. */}
      {shell !== undefined && hasPrompt ? (
        <ShellCommandView
          prompt={turn.prompt}
          shell={shell}
          rollbackCount={rollbackCount}
          onRollback={
            onRollback !== undefined
              ? () => {
                  onRollback(turn.turnId);
                }
              : undefined
          }
        />
      ) : hasPrompt || (isUser && mediaItems.length > 0) ? (
        hubFrom !== undefined && hasPrompt ? (
          <div className="mb-2 flex items-start justify-end gap-1.5">
            <RollbackControl
              rollbackCount={rollbackCount}
              onRollback={
                onRollback !== undefined
                  ? () => {
                      onRollback(turn.turnId);
                    }
                  : undefined
              }
            />
            <HubMessageCard from={hubFrom} text={turn.prompt ?? ''} />
          </div>
        ) : isUser ? (
          <div className="mb-2 flex items-start justify-end gap-1.5">
            <RollbackControl
              rollbackCount={rollbackCount}
              onRollback={
                onRollback !== undefined
                  ? () => {
                      onRollback(turn.turnId);
                    }
                  : undefined
              }
            />
            <div className="max-w-[85%] rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] whitespace-pre-wrap text-neutral-100 sm:max-w-[80%]">
              {hasPrompt ? turn.prompt : null}
              {mediaItems.length > 0 ? (
                <div className={`flex flex-wrap gap-1.5${hasPrompt ? ' mt-2' : ''}`}>
                  {mediaItems.map((attachment) => (
                    <AttachmentMedia
                      key={attachment.attachmentId}
                      attachment={attachment}
                      baseUrl={baseUrl}
                      token={token}
                      sessionId={sessionId}
                      agentId={agentId}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mb-1 flex items-center gap-2">
            <Badge tone={turnStateTone(turn.state)}>{turn.origin.kind}</Badge>
            <span className="text-[11px] whitespace-pre-wrap text-neutral-500">{turn.prompt}</span>
          </div>
        )
      ) : null}
      {/* First-token latency: a running turn with no frame yet gets an
          explicit waiting row; it vanishes the moment the first frame
          streams in. */}
      {turn.state === 'running' && !turn.steps.some((step) => step.frames.length > 0) ? (
        <div className="mb-2 inline-flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-[11px] text-neutral-500">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500/70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          waiting for model…
        </div>
      ) : null}
      {turn.steps.map((step) => (
        <div key={step.stepId}>
          {step.frames.map((frame) => (
            <FrameView
              key={frame.frameId}
              frame={frame}
              streaming={frame.frameId === openTailFrameId}
              planByToolCallId={planByToolCallId}
            />
          ))}
          {step.state === 'interrupted' ? (
            <div className="mb-2 text-[10px] text-neutral-600 italic">step interrupted</div>
          ) : null}
        </div>
      ))}
      {turn.error !== undefined && turn.error !== '' ? (
        <div className="mb-2 max-w-full rounded bg-red-950/50 px-3 py-1.5 text-[11px] whitespace-pre-wrap text-red-400 sm:max-w-[85%]">
          {turn.error}
        </div>
      ) : null}
    </div>
  );
}

function FrameView({
  frame,
  streaming,
  planByToolCallId,
}: {
  frame: TranscriptFrame;
  streaming: boolean;
  planByToolCallId?: ReadonlyMap<string, string>;
}) {
  switch (frame.kind) {
    case 'text':
      return frame.role === 'user' ? (
        <div className="mb-2 flex justify-end">
          {frame.hubFrom !== undefined ? (
            <HubMessageCard from={frame.hubFrom} text={frame.text} />
          ) : (
            <div className="max-w-[85%] rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] whitespace-pre-wrap text-neutral-100 sm:max-w-[80%]">
              {frame.text}
              {streaming ? <StreamCaret /> : null}
            </div>
          )}
        </div>
      ) : (
        <div className="mb-2 max-w-full sm:max-w-[92%]">
          <Markdown text={frame.text} />
          {streaming ? <StreamCaret /> : null}
        </div>
      );
    case 'thinking':
      return <ThinkingFrame text={frame.text} streaming={streaming} />;
    case 'tool':
      return <ToolFrameView frame={frame} planByToolCallId={planByToolCallId} />;
    case 'notice':
      return <NoticeFrameView frame={frame} />;
  }
}

function readAgentPromptInput(
  input: unknown,
): { description?: string; prompt: string } | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Mid-stream the args arrive as unparsed text — keep the raw view.
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['prompt'] !== 'string') return undefined;
  return {
    description: typeof record['description'] === 'string' ? record['description'] : undefined,
    prompt: record['prompt'],
  };
}

function isAgentCallDisplay(display: unknown): boolean {
  return (
    display !== null &&
    typeof display === 'object' &&
    (display as Record<string, unknown>)['kind'] === 'agent_call'
  );
}

function ToolFrameView({
  frame,
  planByToolCallId,
}: {
  frame: ToolCallFrame;
  planByToolCallId?: ReadonlyMap<string, string>;
}) {
  if (frame.name === 'ExitPlanMode') {
    const display = resolveExitPlanDisplay(frame, planByToolCallId?.get(frame.toolCallId));
    // With a recoverable plan the call renders as a plan card (TUI PlanBox
    // parity) instead of a JSON-in-details row.
    if (display.plan !== '') return <ExitPlanModeCard display={display} />;
  }
  const tone =
    frame.state === 'error' ? 'red' : frame.state === 'running' ? 'amber' : 'neutral';
  const subagentStream =
    frame.state === 'running' && frame.progress?.customKind === 'subagent_stream'
      ? readSubagentStreamProgress(frame.progress)
      : undefined;
  const agentInput = frame.name === 'Agent' ? readAgentPromptInput(frame.input) : undefined;
  // The engine's agent_call display payload echoes agent name + prompt, which
  // the prompt card above already shows — skip it for the Agent tool.
  const hideDisplay = frame.name === 'Agent' && isAgentCallDisplay(frame.display);
  const frameClass =
    'mb-2 max-w-full rounded border border-neutral-800 bg-neutral-900/50 px-3 py-1.5 font-mono text-[11px] sm:max-w-[92%]';
  const summaryRow = (
    <>
      <Badge tone={tone}>{frame.state}</Badge>
      <span className="text-neutral-300">{frame.name}</span>
      {frame.view !== undefined && frame.view !== frame.name ? (
        <span className="text-neutral-600">({frame.view})</span>
      ) : null}
      {frame.progress?.percent !== undefined && frame.state === 'running' ? (
        <span className="text-neutral-600">{Math.round(frame.progress.percent)}%</span>
      ) : null}
    </>
  );
  const body = (
    <>
      {agentInput !== undefined ? (
        <>
          <div className="mt-1.5 mb-0.5 text-[10px] text-neutral-600">prompt</div>
          {agentInput.description !== undefined && agentInput.description !== '' ? (
            <div className="mb-1 font-sans text-[12px] text-neutral-300">
              {agentInput.description}
            </div>
          ) : null}
          <div className="max-h-96 overflow-auto font-sans">
            <Markdown text={agentInput.prompt} />
          </div>
        </>
      ) : frame.input !== undefined ? (
        <>
          <div className="mt-1.5 mb-0.5 text-[10px] text-neutral-600">args</div>
          {typeof frame.input === 'string' ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-neutral-500">
              {frame.input}
            </pre>
          ) : (
            <JsonView data={frame.input} />
          )}
        </>
      ) : null}
      {frame.display !== undefined && !hideDisplay ? <JsonView data={frame.display} /> : null}
      {frame.output !== undefined ? (
        <>
          <div className="mt-1.5 mb-0.5 text-[10px] text-neutral-600">result</div>
          {typeof frame.output === 'string' ? (
            <pre
              className={`max-h-64 overflow-auto whitespace-pre-wrap ${
                frame.state === 'error' ? 'text-red-400' : 'text-neutral-400'
              }`}
            >
              {frame.output}
            </pre>
          ) : (
            <JsonView data={frame.output} />
          )}
        </>
      ) : null}
      {frame.error !== undefined && frame.error !== frame.output ? (
        <pre className="mt-1 max-h-40 overflow-auto text-red-400 whitespace-pre-wrap">
          {frame.error}
        </pre>
      ) : null}
    </>
  );
  // A running Agent with a live subagent stream renders as an OPEN container:
  // the summary row and the thinking box nest visibly inside the frame without
  // any click; args/result tuck behind a small "details" toggle. A controlled
  // <details open={...}> would fight the user's manual toggle on every delta
  // render, so the running layout is a plain div instead.
  if (subagentStream !== undefined) {
    return (
      <div className={frameClass}>
        <div className="flex items-center gap-2 select-none">{summaryRow}</div>
        <div className="mt-2">
          <ThinkingFrame
            text={subagentStream.text}
            streaming
            label={`${subagentStream.subagentName ?? 'subagent'} ${
              subagentStream.channel === 'thinking' ? 'thinking' : 'speaking'
            }`}
          />
        </div>
        <details>
          <summary className="cursor-pointer text-[10px] text-neutral-600 select-none hover:text-neutral-400">
            details
          </summary>
          {body}
        </details>
      </div>
    );
  }
  return (
    <details className={frameClass}>
      <summary className="flex cursor-pointer items-center gap-2 select-none">{summaryRow}</summary>
      {body}
    </details>
  );
}

/**
 * ExitPlanMode as a plan card (TUI PlanBox parity): the resolved plan
 * markdown plus the review outcome. Chrome matches the `plan.revision`
 * marker card so a plan reads the same no matter which surface carries it.
 */
function ExitPlanModeCard({ display }: { display: ExitPlanDisplay }) {
  return (
    <div className="mb-3 max-w-full rounded border border-neutral-700/80 bg-neutral-900/40 sm:max-w-[92%]">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-500">
        <span>current plan</span>
        {display.outcome === 'approved' ? (
          <Badge tone="green">
            approved{display.chosen !== undefined ? `: ${display.chosen}` : ''}
          </Badge>
        ) : display.outcome === 'auto_approved' ? (
          <Badge tone="amber">auto-approved · not user-reviewed</Badge>
        ) : display.outcome === 'rejected' ? (
          <Badge tone="red">rejected</Badge>
        ) : (
          <Badge tone="amber">awaiting review…</Badge>
        )}
      </div>
      <div className="px-3 py-2">
        <Markdown text={display.plan} />
        {display.outcome === 'rejected' && display.feedback !== undefined ? (
          <div className="mt-2 rounded bg-amber-950/40 px-2 py-1 text-[11px] whitespace-pre-wrap text-amber-300">
            {display.feedback}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NoticeFrameView({ frame }: { frame: NoticeFrame }) {
  const tone =
    frame.level === 'error'
      ? 'bg-red-950/50 text-red-400'
      : frame.level === 'warning'
        ? 'bg-amber-950/40 text-amber-300'
        : 'bg-neutral-900/60 text-neutral-400';
  return (
    <div className={`mb-2 max-w-full rounded px-3 py-1.5 text-[11px] sm:max-w-[92%] ${tone}`}>
      {frame.source !== undefined ? <span className="text-neutral-500">[{frame.source}] </span> : null}
      {frame.message}
      {frame.detail !== undefined ? <JsonView data={frame.detail} /> : null}
    </div>
  );
}

/**
 * One turn attachment: images/videos render as media thumbs, anything else as
 * a named chip. Sources: `url` (http or inline `data:`) renders directly;
 * `file` (upload store) and `blob` (dehydrated prompt media — the transcript
 * model gains the variant while the shared package ships; narrow locally
 * until then) fetch the bytes through the authenticated blob/files routes
 * once (object URL revoked on unmount). Image thumbs enlarge in a lightbox.
 */
function AttachmentMedia({
  attachment,
  baseUrl,
  token,
  sessionId,
  agentId,
}: {
  attachment: TranscriptAttachment;
  baseUrl: string;
  token: string;
  sessionId: string;
  agentId: string;
}) {
  const source = attachment.source as
    | { kind: 'url'; url: string }
    | { kind: 'file'; fileId: string }
    | { kind: 'session_media'; fileId: string }
    | { kind: 'blob'; ref: string }
    | undefined;
  const directUrl = source?.kind === 'url' ? source.url : undefined;
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (source === undefined || source.kind === 'url') return;
    let revoked: string | undefined;
    let cancelled = false;
    (source.kind === 'blob'
      ? buildBlobPreviewUrl({ baseUrl, token, sessionId, agentId, ref: source.ref })
      : source.kind === 'session_media'
        ? buildSessionMediaPreviewUrl({ baseUrl, token, sessionId, fileId: source.fileId })
        : buildImagePreviewUrl({ baseUrl, token, fileId: source.fileId })
    )
      .then((url) => {
        if (cancelled) revokePreviewUrl(url);
        else {
          revoked = url;
          setFetchedUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (revoked !== undefined) revokePreviewUrl(revoked);
    };
  }, [source, baseUrl, token, sessionId, agentId]);

  const src = directUrl ?? fetchedUrl;
  const mediaType = attachment.mediaType;
  if (src !== null && src !== '') {
    if (mediaType.startsWith('image/')) {
      return <ImageThumb src={src} alt={attachment.name ?? 'image attachment'} />;
    }
    if (mediaType.startsWith('video/')) {
      return (
        <video
          src={src}
          controls
          preload="metadata"
          className="max-h-48 max-w-64 rounded border border-neutral-700"
        />
      );
    }
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[10px] text-neutral-400"
      title={failed ? 'failed to load attachment' : mediaType}
    >
      📎 {attachment.name ?? mediaType}
    </span>
  );
}

/** Click-to-enlarge image thumb — the lightbox dismisses on click or Esc. */
function ImageThumb({ src, alt }: { src: string; alt: string }) {
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setEnlarged(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enlarged]);
  return (
    <>
      <button
        type="button"
        className="block cursor-zoom-in"
        title="enlarge"
        onClick={() => {
          setEnlarged(true);
        }}
      >
        <img src={src} alt={alt} className="max-h-48 max-w-56 rounded border border-neutral-700 object-contain" />
      </button>
      {enlarged ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-label={alt}
          onClick={() => {
            setEnlarged(false);
          }}
        >
          <img src={src} alt={alt} className="max-h-[90vh] max-w-[90vw] rounded object-contain" />
        </div>
      ) : null}
    </>
  );
}
