/**
 * `useTranscriptChannel` — owns the store, the REST load/refresh pipeline,
 * and the WS delta subscription for one (session, transcript-agent) pair.
 *
 *  - FULL state comes from the REST transcript API only: the initial load
 *    reads the newest page, a full refresh re-reads from the tail backwards
 *    until the previously loaded window is re-covered, and "load earlier"
 *    pages further with a `before_turn` cursor (handled by the caller via
 *    `store.applyPage`).
 *  - The WS channel (`/api/v1/ws`) is a DELTA channel only: `transcript.ops`
 *    at `delta` grade (the full stream — per-token `append` chunks included,
 *    so text frames render incrementally); `transcript.reset` snapshots are
 *    ignored. Ops are buffered while a REST refresh is in flight and flushed
 *    onto the fresh pages — idempotent upserts and offset-placed appends make
 *    that converge.
 *  - Loss signals (`resync_required`, append gap, socket reconnect, an op-seq
 *    gap) trigger the sequenced catch-up when a watermark exists, else a full
 *    REST refresh; nothing is resynced from the socket itself.
 */

import {
  EMPTY_AGENT_STATE,
  type AgentDescriptor,
  type AgentState,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { fetchTranscriptOps, fetchTranscriptPage, TRANSCRIPT_PAGE_SIZE } from './api';
import {
  createCoalescedRunner,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from './store';
import { TranscriptWs, type SessionMetaUpdated } from './ws';

const noopSubscribe = () => () => {};

/**
 * The chat pane streams: subscribe at 'delta' so per-token `append` chunks
 * flow (the L1 store already applies them via the shared reducer — the only
 * grade-gated kind is `append`, filtered server-side). Exported for tests.
 */
export const CHANNEL_TRANSCRIPT_GRADE = 'delta' as const;

export interface TranscriptChannel {
  readonly store: TranscriptChatStore | null;
  readonly state: AgentState;
  /** Session agent roster from the last REST page (main + subagents), for tabs. */
  readonly agents: readonly AgentDescriptor[];
  /** True once the initial REST page load succeeded. */
  readonly loaded: boolean;
  readonly loadError: unknown;
}

export interface TranscriptChannelOptions {
  /**
   * `session.meta.updated` frames fan out globally on the WS (rename /
   * auto-title from any client) — forwarded here so the caller keeps its
   * session-title caches fresh. Latest-render lookup (a ref): passing an
   * inline closure never re-creates the channel.
   */
  readonly onSessionMetaUpdated?: ((meta: SessionMetaUpdated) => void) | undefined;
}

export function useTranscriptChannel(
  baseUrl: string,
  token: string,
  sessionId: string | null,
  agentId: string,
  options?: TranscriptChannelOptions,
): TranscriptChannel {
  const [channel, setChannel] = useState<{ store: TranscriptChatStore } | null>(null);
  const [agents, setAgents] = useState<readonly AgentDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  // The channel effect below does not depend on this callback — sync the
  // latest render's value into a ref instead (declared FIRST, so it already
  // holds the current closure when the socket starts dispatching).
  const onMetaUpdatedRef = useRef<((meta: SessionMetaUpdated) => void) | undefined>(undefined);
  useEffect(() => {
    onMetaUpdatedRef.current = options?.onSessionMetaUpdated;
  });

  useEffect(() => {
    if (sessionId === null) return;
    const store = new TranscriptChatStore();
    let disposed = false;
    /** While a REST reload / catch-up is in flight, WS ops are buffered, then flushed. */
    let fetching = true;
    let buffer: TranscriptOperation[] = [];
    /** Max batch seq seen while buffering (folded into the watermark on flush). */
    let bufferedSeq: number | undefined;
    /**
     * Op-batch watermark: the store is known to include every batch with
     * seq <= lastSeq. Sourced from REST page watermarks and applied batch
     * seqs; `undefined` until a sequenced server provides one (legacy
     * servers never do — every recovery then falls back to full refreshes).
     */
    let lastSeq: number | undefined;

    const noteSeq = (seq: number | undefined): void => {
      if (seq === undefined) return;
      lastSeq = lastSeq === undefined ? seq : Math.max(lastSeq, seq);
    };

    const flushBuffer = (): void => {
      fetching = false;
      if (buffer.length > 0) {
        const flushed = buffer;
        store.applyOps(flushed);
        noteSeq(bufferedSeq);
      }
      buffer = [];
      bufferedSeq = undefined;
    };

    /** Page (re)load body shared by the full refresh and the catch-up fallback. */
    const reloadPages = async (): Promise<void> => {
      // The window's oldest turn is the re-cover anchor: after a refresh the
      // server window may have shifted, and only re-loading up to THIS turn
      // preserves the previously loaded history.
      const prevOldest = oldestTurnId(store.getState().items);
      const newest = await fetchTranscriptPage({
        baseUrl,
        token,
        sessionId,
        agentId,
        pageSize: TRANSCRIPT_PAGE_SIZE,
      });
      if (disposed) return;
      store.applyPage(newest, { replace: true });
      lastSeq = newest.seq;
      setAgents(newest.agents);
      // Re-cover the previously loaded window for refreshes (a no-op on the
      // initial load, where there is no previous oldest turn).
      await recoverLoadedWindow(
        store,
        prevOldest,
        (beforeTurn) =>
          fetchTranscriptPage({
            baseUrl,
            token,
            sessionId,
            agentId,
            beforeTurn,
            pageSize: TRANSCRIPT_PAGE_SIZE,
          }),
        () => disposed,
      );
      if (!disposed) {
        setLoaded(true);
        setLoadError(null);
      }
    };

    /** Full-state (re)load: the legacy recovery path and the initial load. */
    const refresh = createCoalescedRunner(async (): Promise<void> => {
      fetching = true;
      buffer = [];
      bufferedSeq = undefined;
      try {
        await reloadPages();
      } catch (error) {
        if (!disposed) setLoadError(error);
      } finally {
        flushBuffer();
      }
    });

    /**
     * Targeted catch-up: fetch exactly the op batches after our watermark
     * (`GET .../transcript/ops?since_seq=`). Falls back to a full page
     * reload on a legacy server (no seq / endpoint missing), a journal that
     * no longer covers the gap (`complete: false`), or a fetch failure.
     */
    const catchUp = createCoalescedRunner(async (): Promise<void> => {
      if (lastSeq === undefined) {
        refresh();
        return;
      }
      fetching = true;
      buffer = [];
      bufferedSeq = undefined;
      try {
        const res = await fetchTranscriptOps({
          baseUrl,
          token,
          sessionId,
          agentId,
          sinceSeq: lastSeq,
        });
        if (disposed) return;
        if (!res.complete) {
          await reloadPages();
        } else {
          for (const batch of res.batches) {
            store.applyOps(batch.ops);
          }
          noteSeq(res.latestSeq);
        }
      } catch {
        try {
          await reloadPages();
        } catch (error) {
          if (!disposed) setLoadError(error);
        }
      } finally {
        flushBuffer();
      }
    });

    const ws = new TranscriptWs({
      url: baseUrl,
      token: token === '' ? undefined : token,
      sessionId,
      agentId,
      grade: CHANNEL_TRANSCRIPT_GRADE,
      getSince: () => lastSeq,
      handlers: {
        onOps: (aid, ops, meta) => {
          if (aid !== agentId) return;
          if (fetching) {
            buffer.push(...ops);
            if (meta?.seq !== undefined) {
              bufferedSeq = Math.max(bufferedSeq ?? 0, meta.seq);
            }
            return;
          }
          // Seq gap: the store is behind by at least one batch. Catch up
          // point-to-point instead of applying on a stale base (appends are
          // offset-placed and would surface a gap anyway).
          if (meta?.seq !== undefined && lastSeq !== undefined && meta.seq > lastSeq + 1) {
            catchUp();
            return;
          }
          store.applyOps(ops);
          noteSeq(meta?.seq);
        },
        onResyncRequired: () => {
          catchUp();
        },
        onReconnected: () => {
          catchUp();
        },
        onSessionMetaUpdated: (meta) => {
          onMetaUpdatedRef.current?.(meta);
        },
        onAgentLifecycle: () => {
          // The roster slice only comes from a REST page — refresh (coalesced)
          // so created/disposed agents join/leave the tab list without a
          // manual reload.
          refresh();
        },
      },
    });
    store.onGap = () => {
      catchUp();
    };
    setChannel({ store });
    setLoaded(false);
    setLoadError(null);
    refresh();
    return () => {
      disposed = true;
      ws.close();
      setChannel(null);
      setAgents([]);
    };
  }, [sessionId, agentId, baseUrl, token]);

  const state = useSyncExternalStore(
    channel?.store.subscribe ?? noopSubscribe,
    () => channel?.store.getState() ?? EMPTY_AGENT_STATE,
  );
  return { store: channel?.store ?? null, state, agents, loaded, loadError };
}
