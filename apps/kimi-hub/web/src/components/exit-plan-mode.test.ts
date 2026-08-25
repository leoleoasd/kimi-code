import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { planReviewDisplayPlan, resolveExitPlanDisplay } from './exit-plan-mode';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'ExitPlanMode',
    state: 'done',
    ...overrides,
  };
}

const PLAN = '# Plan\n\n1. do the thing\n2. test it';

describe('resolveExitPlanDisplay', () => {
  it('takes the plan from inline input args first', () => {
    const display = resolveExitPlanDisplay(frame({ input: { plan: PLAN + '\n' } }));
    expect(display.plan).toBe(PLAN);
    expect(display.outcome).toBe('pending');
  });

  it('parses mid-stream JSON-string input', () => {
    const display = resolveExitPlanDisplay(frame({ input: JSON.stringify({ plan: PLAN }) }));
    expect(display.plan).toBe(PLAN);
  });

  it('extracts the approved plan and outcome from the output', () => {
    const display = resolveExitPlanDisplay(
      frame({ output: `Exited plan mode. Plan saved to: /tmp/plan.md\n\n## Approved Plan:\n\n${PLAN}` }),
    );
    expect(display.outcome).toBe('approved');
    expect(display.plan).toBe(PLAN);
  });

  it('marks auto-approved output distinctly', () => {
    const display = resolveExitPlanDisplay(
      frame({
        output: `Exited plan mode.\n\n## Plan (auto-approved, not user-reviewed):\n\n${PLAN}`,
      }),
    );
    expect(display.outcome).toBe('auto_approved');
    expect(display.plan).toBe(PLAN);
  });

  it('reads the chosen option from the review picker output', () => {
    const display = resolveExitPlanDisplay(
      frame({ output: `Exited plan mode. Selected approach: Staged rollout\n\n## Approved Plan:\n\n${PLAN}` }),
    );
    expect(display.outcome).toBe('approved');
    expect(display.chosen).toBe('Staged rollout');
  });

  it('reads the legacy approved-option phrasing', () => {
    const display = resolveExitPlanDisplay(
      frame({ output: `User approved option "Fast path".\n\n## Approved Plan:\n\n${PLAN}` }),
    );
    expect(display.outcome).toBe('approved');
    expect(display.chosen).toBe('Fast path');
  });

  it('surfaces rejection feedback', () => {
    const display = resolveExitPlanDisplay(
      frame({ output: 'User rejected the plan. Feedback:\n\nneeds a rollback story', input: { plan: PLAN } }),
    );
    expect(display.outcome).toBe('rejected');
    expect(display.feedback).toBe('needs a rollback story');
  });

  it('handles the bare rejection prefixes without feedback', () => {
    expect(resolveExitPlanDisplay(frame({ output: 'Plan rejected by user.', input: { plan: PLAN } })).outcome).toBe('rejected');
    const bare = resolveExitPlanDisplay(frame({ output: 'User rejected the plan.', input: { plan: PLAN } }));
    expect(bare.outcome).toBe('rejected');
    expect(bare.feedback).toBeUndefined();
  });

  it('falls back to the server-recovered plan (plan-file mode)', () => {
    const display = resolveExitPlanDisplay(
      frame({ input: {}, output: 'Exited plan mode.' }),
      PLAN,
    );
    expect(display.plan).toBe(PLAN);
    expect(display.outcome).toBe('approved');
  });

  it('reports pending with no known protocol output', () => {
    const display = resolveExitPlanDisplay(frame({ input: { plan: PLAN } }), undefined);
    expect(display.outcome).toBe('pending');
  });

  it('yields an empty plan when no source has one', () => {
    const display = resolveExitPlanDisplay(frame({ input: {}, output: 'Exited plan mode.' }));
    expect(display.plan).toBe('');
  });
});

describe('planReviewDisplayPlan', () => {
  it('pulls the plan out of the approval plan_review display', () => {
    expect(planReviewDisplayPlan({ kind: 'plan_review', plan: PLAN })).toBe(PLAN);
  });

  it('parses a still-stringified display', () => {
    expect(planReviewDisplayPlan(JSON.stringify({ kind: 'plan_review', plan: PLAN }))).toBe(PLAN);
  });

  it('ignores generic tool input', () => {
    expect(planReviewDisplayPlan({ command: 'ls' })).toBeUndefined();
    expect(planReviewDisplayPlan({ kind: 'plan_review', plan: '  ' })).toBeUndefined();
    expect(planReviewDisplayPlan('not json')).toBeUndefined();
    expect(planReviewDisplayPlan(null)).toBeUndefined();
  });
});
