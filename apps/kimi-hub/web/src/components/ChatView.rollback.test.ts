import { describe, expect, it } from 'vitest';

import type { TranscriptItem } from '@moonshot-ai/transcript';

import { rollbackCountsForItems } from './ChatView';

function turn(
  turnId: string,
  origin: 'user' | 'cron' | 'side' = 'user',
  state: 'completed' | 'running' | 'queued' | 'cancelled' = 'completed',
): TranscriptItem {
  return { kind: 'turn', turnId, origin: { kind: origin }, state, steps: [] } as unknown as TranscriptItem;
}

function marker(markerId: string): TranscriptItem {
  return { kind: 'marker', markerId, marker: { kind: 'notice', level: 'info', text: 'x' } } as unknown as TranscriptItem;
}

describe('rollbackCountsForItems', () => {
  it('counts user turns back from the end (tail-complete view)', () => {
    const counts = rollbackCountsForItems([turn('t1'), turn('t2'), turn('t3')]);
    expect(counts.get('t3')).toBe(1);
    expect(counts.get('t2')).toBe(2);
    expect(counts.get('t1')).toBe(3);
  });

  it('skips non-user origins and queued turns, and never maps markers', () => {
    const counts = rollbackCountsForItems([
      turn('t1'),
      turn('cron-1', 'cron'),
      turn('t2'),
      turn('q1', 'user', 'queued'),
      marker('m1'),
    ]);
    expect(counts.get('t2')).toBe(1);
    expect(counts.get('t1')).toBe(2);
    expect(counts.has('cron-1')).toBe(false);
    expect(counts.has('q1')).toBe(false);
    expect(counts.size).toBe(2);
  });

  it('empty in / empty out', () => {
    expect(rollbackCountsForItems([]).size).toBe(0);
  });
});
