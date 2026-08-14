/**
 * Chat-store glue tests — the app's own wrapper over the L1 reducer. The
 * reducer semantics themselves are covered by `@moonshot-ai/transcript`'s
 * own suite and are intentionally not re-tested here.
 */

import type { StepHeader, TranscriptOperation, TurnHeader, TurnState } from '@moonshot-ai/transcript';
import { describe, expect, it, vi } from 'vitest';

import type { TranscriptPage } from './api';
import {
  createCoalescedRunner,
  hasTurnId,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from './store';

// ---------------------------------------------------------------- fixtures

function turnHeader(n: number, state: TurnState = 'completed'): TurnHeader {
  return { kind: 'turn', turnId: `t${n}`, ordinal: n, state, origin: { kind: 'user' } };
}

function stepHeader(stepId: string, ordinal: number): StepHeader {
  return { kind: 'step', stepId, turnId: stepId.split('.')[0] ?? 't1', ordinal, state: 'running' };
}

function page(items: TranscriptPage['items'], hasMoreOlder = false): TranscriptPage {
  return {
    items,
    hasMoreOlder,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    meta: {},
    pendingInteractions: [],
    agents: [],
  };
}

describe('TranscriptChatStore', () => {
  it('a replace page becomes the whole state', () => {
    const store = new TranscriptChatStore();
    store.applyPage(page([{ ...turnHeader(2), ordinal: 2, steps: [] }]), { replace: true });
    expect(store.getState().items).toHaveLength(1);
    expect(store.getState().items[0]?.kind).toBe('turn');
    expect(oldestTurnId(store.getState().items)).toBe('t2');
  });

  it('a non-replace page prepends, deduped by item id', () => {
    const store = new TranscriptChatStore();
    store.applyPage(page([{ ...turnHeader(2), steps: [] }, { ...turnHeader(3), steps: [] }]), {
      replace: true,
    });
    // Fresh + duplicate: t1 is new, t2 repeats — only t1 lands ahead.
    store.applyPage(page([{ ...turnHeader(1), steps: [] }, { ...turnHeader(2), steps: [] }]));
    const ids = store.getState().items.map((item) => item.kind === 'turn' && item.turnId);
    expect(ids).toEqual(['t1', 't2', 't3']);
  });

  it('applies incremental ops through the shared reducer', () => {
    const store = new TranscriptChatStore();
    const ops: readonly TranscriptOperation[] = [
      { op: 'turn.upsert', turn: turnHeader(1, 'running') },
      { op: 'step.upsert', turnId: 't1', step: stepHeader('t1.1', 1) },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'hello' },
      },
      {
        op: 'append',
        target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
        offset: 5,
        text: ' world',
      },
    ];
    store.applyOps(ops);
    const turn = store.getState().items[0];
    expect(turn?.kind).toBe('turn');
    if (turn?.kind !== 'turn') return;
    expect(turn.steps[0]?.frames[0]).toMatchObject({ kind: 'text', text: 'hello world' });
  });

  it('a replace page clears state accumulated from ops', () => {
    const store = new TranscriptChatStore();
    store.applyOps([{ op: 'turn.upsert', turn: turnHeader(9, 'running') }]);
    store.applyPage(page([]), { replace: true });
    expect(store.getState().items).toHaveLength(0);
  });
});

describe('recoverLoadedWindow', () => {
  it('pages backwards until the anchor turn re-enters the window', async () => {
    const store = new TranscriptChatStore();
    store.applyPage(page([{ ...turnHeader(3), steps: [] }], true), { replace: true });
    // Anchor is t1: two pages back (t2, then t1).
    await recoverLoadedWindow(
      store,
      't1',
      async (beforeTurn) => {
        expect(['t3', 't2']).toContain(beforeTurn);
        const n = Number(beforeTurn.slice(1)) - 1;
        return {
          ...page([{ ...turnHeader(n), steps: [] }], n > 1),
          hasMoreOlder: n > 1,
        };
      },
      () => false,
    );
    expect(hasTurnId(store.getState().items, 't1')).toBe(true);
    expect(store.getState().items).toHaveLength(3);
  });

  it('stops when no older page makes progress', async () => {
    const store = new TranscriptChatStore();
    store.applyPage(page([{ ...turnHeader(2), steps: [] }], false), { replace: true });
    await recoverLoadedWindow(store, 't1', async () => page([], false), () => false);
    expect(hasTurnId(store.getState().items, 't1')).toBe(false);
  });
});

describe('createCoalescedRunner', () => {
  it('serializes and coalesces concurrent kicks into one follow-up', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const kick = createCoalescedRunner(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          release = resolve;
        }),
    );
    kick();
    kick();
    kick();
    expect(calls).toBe(1);
    release?.();
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
  });
});
