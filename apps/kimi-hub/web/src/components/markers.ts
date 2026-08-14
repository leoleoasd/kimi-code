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

const MARKER_LABELS: Record<string, string> = {
  undo: 'conversation rolled back',
  compact: 'context compacted',
  compaction: 'context compacted',
  interruption: 'interrupted',
};

/**
 * Marker kinds that never become a chat row: internal bookkeeping whose
 * substance already has a first-class surface (goal state → goal surfaces;
 * skill activation → the Skill tool frame; a cron fire → the turn it spawns).
 */
const HIDDEN_MARKERS = new Set(['goal', 'skill', 'plugin_command', 'cron.fired']);

export function markerLabel(marker: string): string {
  return MARKER_LABELS[marker] ?? marker;
}

export function isVisibleMarker(marker: string): boolean {
  return !HIDDEN_MARKERS.has(marker);
}

/** One rendered row: an item plus how many consecutive identical rows it stands for. */
export interface CollapsedRow {
  readonly item: TranscriptItem;
  readonly repeat: number;
  readonly key: string;
}

function rowIdentity(item: TranscriptItem): string | undefined {
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
