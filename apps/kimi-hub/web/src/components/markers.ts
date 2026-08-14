/**
 * Friendly one-line labels for transcript markers. Markers render as a plain
 * timeline divider — the label is all a user sees, so known keys get a human
 * sentence and everything else shows the raw key as-is. The marker payload
 * (undo splice args, compaction stats, …) is internal and never rendered.
 */

const MARKER_LABELS: Record<string, string> = {
  undo: 'conversation rolled back',
  compact: 'context compacted',
  compaction: 'context compacted',
};

export function markerLabel(marker: string): string {
  return MARKER_LABELS[marker] ?? marker;
}
