/**
 * Friendly one-line labels for transcript markers, plus the chat-row
 * visibility policy.
 *
 * The transcript is a faithful chronicle of engine bookkeeping — every goal
 * snapshot tick, skill activation, cron fire, compaction phase — not only
 * conversation signposts. On a long noisy session those rows drown the
 * actual messages ~10:1 ("marker wall"). `isVisibleMarker` keeps the rows a
 * human reads a chat for and drops the bookkeeping; `collapseMarkerRuns`
 * folds consecutive repeats of the same marker (a burst of interrupts, the
 * phases of one compaction) into a single labelled `×n` row.
 */

import type { TranscriptItem } from '@moonshot-ai/transcript';

import type { SessionPlanEntry } from '#/sessions/api';

const MARKER_LABELS: Record<string, string> = {
  undo: 'conversation rolled back',
  compact: 'context compacted',
  compaction: 'context compacted',
  interruption: 'interrupted',
};

/**
 * The live phase question the chat header asks: is a compaction currently in
 * flight — i.e. the newest compaction marker on the viewed agent's transcript
 * is a bare `compaction.started` (no completed/cancelled after it). The
 * transcript stream already carries every phase marker, so this needs no
 * extra endpoint.
 */
export function compactionInProgress(items: readonly TranscriptItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind !== 'marker' || item.marker !== 'compaction') continue;
    return (item.payload as { phase?: unknown } | undefined)?.phase === 'started';
  }
  return false;
}

/**
 * Marker kinds that never become a chat row: internal bookkeeping whose
 * substance already has a first-class surface (goal state → goal surfaces;
 * skill activation → the Skill tool frame; a cron fire → the turn it spawns).
 */
const HIDDEN_MARKERS = new Set(['goal', 'skill', 'plugin_command', 'cron.fired']);

export function markerLabel(marker: string, payload?: unknown): string {
  if (marker === 'compaction') {
    const phase = (payload as { phase?: unknown } | undefined)?.phase;
    return phase === 'started' ? 'compacting context…' : 'context compacted';
  }
  return MARKER_LABELS[marker] ?? marker;
}

export function isVisibleMarker(marker: string): boolean {
  return !HIDDEN_MARKERS.has(marker);
}

// ---------------------------------------------------------------- plan pairing

/** What a `plan.revision` marker row renders when its content is known. */
export interface PlanMarkerContent {
  readonly plan: string;
  readonly version?: number;
}

/** Marker's plan blob file reference: `<scope>/plan/<planId>/v<N>.md`. */
const REVISION_BLOB_PATH = /\/plan\/([^/]+)\/v\d+\.md$/;
/** Plan entry's live working file reference: `<sessionDir>/…/plans/<planId>.md`. */
const WORKING_PLAN_PATH = /\/plans\/([^/]+)\.md$/;

function idFromPath(path: unknown, pattern: RegExp): string | undefined {
  return typeof path === 'string' ? pattern.exec(path)?.[1] : undefined;
}

function markerPlanId(payload: unknown): string | undefined {
  const p = payload as { id?: unknown; path?: unknown } | undefined;
  if (typeof p?.id === 'string') return p.id;
  return idFromPath(p?.path, REVISION_BLOB_PATH);
}

/**
 * Pair `plan.revision` markers with the plan entries recovered by
 * `fetchSessionPlans`. Both sides are timeline-ordered per plan file, so the
 * marker recording version N pairs with the plan's N-th recoverable entry;
 * entries whose content the server could not recover (e.g. a cold "Revise"
 * call) never appear, so an over-indexed marker degrades to that plan's
 * LATEST known content (never a bare row — displaying some plan beats
 * displaying none). Plan-id-less payloads/entries share one catch-all group.
 */
export function buildPlanByMarker(
  items: readonly TranscriptItem[],
  entries: readonly SessionPlanEntry[],
): ReadonlyMap<string, PlanMarkerContent> {
  const byMarker = new Map<string, PlanMarkerContent>();
  if (entries.length === 0) return byMarker;
  const entryGroups = new Map<string, SessionPlanEntry[]>();
  for (const entry of entries) {
    const id = idFromPath(entry.path, WORKING_PLAN_PATH) ?? '';
    const group = entryGroups.get(id);
    if (group === undefined) entryGroups.set(id, [entry]);
    else group.push(entry);
  }
  const markerIndex = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== 'marker' || item.marker !== 'plan.revision') continue;
    const id = markerPlanId(item.payload) ?? '';
    const index = markerIndex.get(id) ?? 0;
    markerIndex.set(id, index + 1);
    const group = entryGroups.get(id) ?? entryGroups.get('');
    if (group === undefined || group.length === 0) continue;
    const entry = group[Math.min(index, group.length - 1)]!;
    const version = (item.payload as { version?: unknown } | undefined)?.version;
    byMarker.set(item.markerId, {
      plan: entry.plan,
      version: typeof version === 'number' ? version : undefined,
    });
  }
  return byMarker;
}

/** One rendered row: an item plus how many consecutive identical rows it stands for. */
export interface CollapsedRow {
  readonly item: TranscriptItem;
  readonly repeat: number;
  readonly key: string;
}

function rowIdentity(item: TranscriptItem): string | undefined {
  // plan.revision rows are content-bearing (each pairs its own plan version)
  // — folding a run of them into one ×n row would hide every version but
  // the first.
  if (item.kind === 'marker' && item.marker === 'plan.revision') return undefined;
  if (item.kind === 'marker') return item.marker;
  if (item.kind === 'taskref') return 'taskref';
  return undefined;
}

/**
 * Conversation view over the raw item list: bookkeeping markers dropped,
 * consecutive identical marker/taskref rows collapsed into one `repeat`-counted
 * row. Turns (the rollback anchors / load-older cursors) are never touched —
 * callers computing ordinals keep using the RAW items.
 */
export function collapseMarkerRuns(items: readonly TranscriptItem[]): CollapsedRow[] {
  const rows: CollapsedRow[] = [];
  for (const item of items) {
    if (item.kind === 'marker' && !isVisibleMarker(item.marker)) continue;
    const identity = rowIdentity(item);
    const prev = rows.at(-1);
    if (identity !== undefined && prev !== undefined && rowIdentity(prev.item) === identity) {
      rows[rows.length - 1] = { item: prev.item, repeat: prev.repeat + 1, key: prev.key };
      continue;
    }
    const id = item.kind === 'marker' ? item.markerId : item.kind === 'taskref' ? item.refId : item.turnId;
    rows.push({ item, repeat: 1, key: id });
  }
  return rows;
}
