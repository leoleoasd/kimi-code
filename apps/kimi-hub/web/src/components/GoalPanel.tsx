/**
 * The session's current goal, panel-style — TodoListPanel's neighbour: what
 * the objective is and whether it is still driving (active) or parked
 * (paused/blocked), with the lifecycle buttons that answer the engine's
 * `goal_control` wire controls directly (`POST …/prompts`, no bridge, no
 * TUI). Data rides the transcript meta (`goal.updated` ops), so the panel
 * flips live with zero polling. Hidden when there is no goal and when the
 * goal completed (matches the header badge's rule).
 */

import type { GoalMeta } from '@moonshot-ai/transcript';

import { ActionButton } from './ui';

export interface GoalPanelView {
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'blocked';
  readonly completionCriterion?: string;
  readonly budget?: { readonly used: number; readonly limit?: number };
  /** The one lifecycle button the current state offers; complete/none hide the panel. */
  readonly action?: 'pause' | 'resume';
}

/**
 * Decide the panel's contents; `undefined` hides it entirely. Paused and
 * blocked both offer Resume (the wire resume continues both — continue_if_*
 * flags in the route) — Blocked informs the user the goal hit its stop rule,
 * not that it is driveable.
 */
export function goalPanelView(goal: GoalMeta | undefined): GoalPanelView | undefined {
  if (goal === undefined || goal.status === 'complete') return undefined;
  const budget =
    goal.budgetUsed !== undefined ? { used: goal.budgetUsed, limit: goal.budgetLimit } : undefined;
  switch (goal.status) {
    case 'active':
      return { objective: goal.objective, status: 'active', completionCriterion: goal.completionCriterion, budget, action: 'pause' };
    case 'paused':
      return { objective: goal.objective, status: 'paused', completionCriterion: goal.completionCriterion, budget, action: 'resume' };
    case 'blocked':
      return { objective: goal.objective, status: 'blocked', completionCriterion: goal.completionCriterion, budget, action: 'resume' };
  }
}

const STATUS_CHIP: Record<GoalPanelView['status'], { label: string; className: string }> = {
  active: { label: 'active', className: 'text-green-400' },
  paused: { label: 'paused', className: 'text-amber-400' },
  blocked: { label: 'blocked', className: 'text-red-400' },
};

export function GoalPanel({
  goal,
  busy,
  onControl,
}: {
  goal: GoalMeta | undefined;
  busy: boolean;
  onControl: (control: 'pause' | 'resume') => void;
}) {
  const view = goalPanelView(goal);
  if (view === undefined) return null;
  const chip = STATUS_CHIP[view.status];
  return (
    <div className="border-t border-neutral-800/80 px-3 py-1.5 lg:px-4" aria-label="goal">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-medium tracking-wide uppercase">
        <span className="text-neutral-500">goal</span>
        <span className={chip.className}>{chip.label}</span>
        {view.action !== undefined ? (
          <ActionButton
            disabled={busy}
            onClick={() => {
              onControl(view.action!);
            }}
          >
            {view.action === 'pause' ? 'Pause' : 'Resume'}
          </ActionButton>
        ) : null}
      </div>
      <div className="line-clamp-2 text-[11px] whitespace-pre-wrap text-neutral-300" title={view.objective}>
        {view.objective}
      </div>
      {view.completionCriterion !== undefined && view.completionCriterion !== '' ? (
        <div className="mt-0.5 line-clamp-1 text-[10px] text-neutral-500" title={view.completionCriterion}>
          done when: {view.completionCriterion}
        </div>
      ) : null}
      {view.budget !== undefined ? (
        <div className="mt-0.5 text-[10px] text-neutral-500">
          turns: {String(view.budget.used)}
          {view.budget.limit !== undefined ? ` / ${String(view.budget.limit)}` : ''}
        </div>
      ) : null}
    </div>
  );
}
