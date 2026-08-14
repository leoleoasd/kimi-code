/**
 * Marker label mapping — markers render as a divider with a friendly label;
 * unknown keys fall back to the raw marker name as-is — plus the chat-row
 * visibility/collapse rules (`collapseMarkerRuns`) that keep engine
 * bookkeeping (goal ticks, skill activations, cron fires) and marker bursts
 * from drowning the conversation.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@moonshot-ai/transcript';

import { collapseMarkerRuns, compactionInProgress, isVisibleMarker, markerLabel } from './markers';

describe('markerLabel', () => {
  it('maps known markers to friendly labels', () => {
    expect(markerLabel('undo')).toBe('conversation rolled back');
    expect(markerLabel('compact')).toBe('context compacted');
    expect(markerLabel('compaction')).toBe('context compacted');
  });

  it('a bare started compaction reads as in-flight; completed ones read as the outcome', () => {
    expect(markerLabel('compaction', { phase: 'started' })).toBe('compacting context…');
    expect(markerLabel('compaction', { phase: 'completed' })).toBe('context compacted');
    expect(markerLabel('compaction', { phase: 'cancelled' })).toBe('context compacted');
  });

  it('falls back to the raw marker name as-is', () => {
    expect(markerLabel('goal')).toBe('goal');
    expect(markerLabel('plan.enter')).toBe('plan.enter');
    expect(markerLabel('custom:my-plugin')).toBe('custom:my-plugin');
  });
});

function marker(id: string, kind: string, payload?: unknown): TranscriptItem {
  return { kind: 'marker', markerId: id, marker: kind, payload } as TranscriptItem;
}

function taskref(id: string): TranscriptItem {
  return { kind: 'taskref', refId: id, taskId: id, at: '2026-08-14T00:00:00Z' } as TranscriptItem;
}

function turn(id: string): TranscriptItem {
  return { kind: 'turn', turnId: id, ordinal: Number(id.slice(1)), state: 'completed', origin: { kind: 'user' }, steps: [] } as unknown as TranscriptItem;
}

describe('isVisibleMarker', () => {
  it('hides engine bookkeeping markers', () => {
    expect(isVisibleMarker('goal')).toBe(false);
    expect(isVisibleMarker('skill')).toBe(false);
    expect(isVisibleMarker('cron.fired')).toBe(false);
  });

  it('keeps conversation signposts', () => {
    expect(isVisibleMarker('compaction')).toBe(true);
    expect(isVisibleMarker('undo')).toBe(true);
    expect(isVisibleMarker('interruption')).toBe(true);
    expect(isVisibleMarker('plan.revision')).toBe(true);
  });
});

describe('collapseMarkerRuns', () => {
  it('drops hidden markers and keeps turns + visible markers', () => {
    const rows = collapseMarkerRuns([
      turn('t1'),
      marker('m1', 'goal'),
      marker('m2', 'compaction'),
      marker('m3', 'skill'),
      turn('t2'),
    ]);
    expect(rows.map((row) => row.item)).toEqual([turn('t1'), marker('m2', 'compaction'), turn('t2')]);
    expect(rows.every((row) => row.repeat === 1)).toBe(true);
  });

  it('collapses a burst of identical markers into one repeat-counted row', () => {
    const rows = collapseMarkerRuns([
      turn('t1'),
      marker('m1', 'interruption'),
      marker('m2', 'interruption'),
      marker('m3', 'interruption'),
      turn('t2'),
      marker('m4', 'interruption'),
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ repeat: 3, key: 'm1' });
    expect(rows[3]).toMatchObject({ repeat: 1, key: 'm4' });
  });

  it('collapses consecutive taskrefs but never markers of different kinds', () => {
    const rows = collapseMarkerRuns([
      taskref('r1'),
      taskref('r2'),
      marker('m1', 'compaction'),
      marker('m2', 'undo'),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ repeat: 2, key: 'r1' });
    expect(rows[1]).toMatchObject({ repeat: 1, key: 'm1' });
    expect(rows[2]).toMatchObject({ repeat: 1, key: 'm2' });
  });
});

describe('compactionInProgress', () => {
  it('is false with no compaction marker at all', () => {
    expect(compactionInProgress([])).toBe(false);
    expect(compactionInProgress([turn('t1')])).toBe(false);
  });

  it('is true while the newest compaction marker is a bare started', () => {
    expect(
      compactionInProgress([
        turn('t1'),
        marker('m1', 'compaction', { phase: 'started' }),
      ]),
    ).toBe(true);
  });

  it('is false once a terminal phase lands (completed / cancelled / blocked)', () => {
    for (const phase of ['completed', 'cancelled', 'blocked'] as const) {
      expect(
        compactionInProgress([
          marker('m1', 'compaction', { phase: 'started' }),
          marker('m2', 'compaction', { phase }),
        ]),
      ).toBe(false);
    }
  });

  it('an earlier completed marker does not hide a later in-flight one', () => {
    expect(
      compactionInProgress([
        marker('m1', 'compaction', { phase: 'completed' }),
        marker('m2', 'compaction', { phase: 'started' }),
      ]),
    ).toBe(true);
  });
});
