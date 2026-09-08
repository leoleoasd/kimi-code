/**
 * Goal panel projection: hidden without a goal or once complete, one
 * lifecycle button per parked state, budget surfaced only when budgeted.
 */

import { describe, expect, it } from 'vitest';
import type { GoalMeta } from '@moonshot-ai/transcript';

import { goalPanelView } from './GoalPanel';

function goal(overrides: Partial<GoalMeta>): GoalMeta {
  return { objective: 'ship x', status: 'active', ...overrides };
}

describe('goalPanelView', () => {
  it('hides without a goal and when the goal completed', () => {
    expect(goalPanelView(undefined)).toBeUndefined();
    expect(goalPanelView(goal({ status: 'complete' }))).toBeUndefined();
  });

  it('an active goal offers Pause', () => {
    const view = goalPanelView(goal({}));
    expect(view?.status).toBe('active');
    expect(view?.action).toBe('pause');
    expect(view?.objective).toBe('ship x');
  });

  it('paused and blocked both offer Resume, keeping their own status', () => {
    expect(goalPanelView(goal({ status: 'paused' }))?.action).toBe('resume');
    const blocked = goalPanelView(goal({ status: 'blocked' }));
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.action).toBe('resume');
  });

  it('completion criterion and budget ride through only when present', () => {
    const bare = goalPanelView(goal({}));
    expect(bare?.completionCriterion).toBeUndefined();
    expect(bare?.budget).toBeUndefined();
    const full = goalPanelView(
      goal({ completionCriterion: 'ci green', budgetUsed: 12, budgetLimit: 20 }),
    );
    expect(full?.completionCriterion).toBe('ci green');
    expect(full?.budget).toEqual({ used: 12, limit: 20 });
  });

  it('a used budget without a limit still shows', () => {
    expect(goalPanelView(goal({ budgetUsed: 3 }))?.budget).toEqual({ used: 3, limit: undefined });
  });
});
