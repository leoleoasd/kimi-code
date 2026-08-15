/**
 * Marker label mapping — markers render as a divider with a friendly label;
 * unknown keys fall back to the raw marker name as-is — plus the chat-row
 * visibility/collapse rules (`collapseMarkerRuns`) that keep engine
 * bookkeeping (goal ticks, skill activations, cron fires) and marker bursts
 * from drowning the conversation.
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@moonshot-ai/transcript';

import type { SessionPlanEntry } from '#/sessions/api';
import {
  buildPlanByMarker,
  collapseMarkerRuns,
  compactionInProgress,
  isVisibleMarker,
  markerLabel,
} from './markers';

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

  it('never collapses plan.revision rows — each carries its own plan version', () => {
    const rows = collapseMarkerRuns([
      marker('m1', 'plan.revision', { id: 'p', version: 1 }),
      marker('m2', 'plan.revision', { id: 'p', version: 2 }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(['m1', 'm2']);
    expect(rows.every((row) => row.repeat === 1)).toBe(true);
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

function planEntry(toolCallId: string, plan: string, path?: string): SessionPlanEntry {
  return { toolCallId, turnId: 'turn_1', source: 'display', plan, path };
}

describe('buildPlanByMarker', () => {
  const markerItems = [
    turn('t1'),
    marker('m1', 'plan.revision', { id: 'p', version: 1, path: 'sessions/w/s/agents/main/plan/p/v1.md' }),
    turn('t2'),
    marker('m2', 'plan.revision', { id: 'p', version: 2, path: 'sessions/w/s/agents/main/plan/p/v2.md' }),
  ];

  it('pairs each revision marker with its ordered plan entry', () => {
    const byMarker = buildPlanByMarker(markerItems, [
      planEntry('c1', 'plan v1', '/home/u/.kimi-code/sessions/w/s/agents/main/plans/p.md'),
      planEntry('c2', 'plan v2', '/home/u/.kimi-code/sessions/w/s/agents/main/plans/p.md'),
    ]);
    expect(byMarker.get('m1')).toEqual({ plan: 'plan v1', version: 1 });
    expect(byMarker.get('m2')).toEqual({ plan: 'plan v2', version: 2 });
  });

  it('an unrecoverable entry degrades to the plan\'s latest known content, never a bare row', () => {
    const byMarker = buildPlanByMarker(markerItems, [planEntry('c2', 'plan v2', 'x/plans/p.md')]);
    expect(byMarker.get('m1')).toEqual({ plan: 'plan v2', version: 1 });
    expect(byMarker.get('m2')).toEqual({ plan: 'plan v2', version: 2 });
  });

  it('joins plan-id groups and falls back to the catch-all group', () => {
    const items = [
      marker('m1', 'plan.revision', { id: 'a', version: 1 }),
      marker('m2', 'plan.revision', { version: 1 }),
      marker('m3', 'plan.revision'),
    ];
    const byMarker = buildPlanByMarker(items, [
      planEntry('c1', 'plan A', 'x/plans/a.md'),
      planEntry('c2', 'no-path plan'),
    ]);
    expect(byMarker.get('m1')?.plan).toBe('plan A');
    expect(byMarker.get('m2')?.plan).toBe('no-path plan');
    expect(byMarker.get('m3')?.plan).toBe('no-path plan');
  });

  it('returns an empty map without entries', () => {
    expect(buildPlanByMarker(markerItems, []).size).toBe(0);
  });
});
