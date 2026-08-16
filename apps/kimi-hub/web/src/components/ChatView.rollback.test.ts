import { describe, expect, it } from 'vitest';

import type { TranscriptItem } from '@moonshot-ai/transcript';

import { rollbackCountsForItems, shouldRepin } from './ChatView';

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

describe('shouldRepin', () => {
  it('never re-pins on upward ticks inside the tail zone (slow trackpad scroll)', () => {
    // The reported bug: each 1–2px wheel tick re-armed the pin, so the next
    // growth snap yanked the viewport back to the tail.
    expect(shouldRepin(-2, 2)).toBe(false);
    expect(shouldRepin(-2, 79)).toBe(false);
    expect(shouldRepin(-100, 400)).toBe(false);
  });

  it('re-pins when scrolling down into the tail zone', () => {
    expect(shouldRepin(10, 79)).toBe(true);
    expect(shouldRepin(10, 0)).toBe(true);
  });

  it('does not re-pin while far from the tail even when scrolling down', () => {
    expect(shouldRepin(10, 200)).toBe(false);
  });

  it('re-pins when resting exactly on the tail (no upward motion)', () => {
    expect(shouldRepin(0, 0)).toBe(true);
    expect(shouldRepin(0, -1)).toBe(true);
  });

  it('does not re-pin while leaving overscroll below the tail', () => {
    expect(shouldRepin(-1, -3)).toBe(false);
  });
});

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
