import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { resolveGoalDisplay } from './goal';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'CreateGoal',
    state: 'done',
    ...overrides,
  };
}

describe('resolveGoalDisplay', () => {
  it('takes objective, criterion and mode from the goal_start payload', () => {
    const display = resolveGoalDisplay(
      frame({
        display: {
          kind: 'goal_start',
          objective: 'land the fix',
          completionCriterion: 'CI green',
          mode: 'yolo',
        },
      }),
    );
    expect(display).toEqual({ objective: 'land the fix', completionCriterion: 'CI green', mode: 'yolo' });
  });

  it('falls back to the input args and defaults the mode to manual', () => {
    const display = resolveGoalDisplay(frame({ input: { objective: 'ship it' } }));
    expect(display).toEqual({ objective: 'ship it', completionCriterion: undefined, mode: 'manual' });
  });

  it('parses JSON-string input', () => {
    expect(resolveGoalDisplay(frame({ input: '{"objective":"o","completionCriterion":"c"}' }))).toEqual({
      objective: 'o',
      completionCriterion: 'c',
      mode: 'manual',
    });
  });

  it('ignores other tools and frames without an objective', () => {
    expect(resolveGoalDisplay(frame({ name: 'UpdateGoal' }))).toBeUndefined();
    expect(resolveGoalDisplay(frame({ input: { mode: 'yolo' } }))).toBeUndefined();
  });
});
