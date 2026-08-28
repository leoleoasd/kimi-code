import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface GoalDisplay {
  objective: string;
  completionCriterion?: string;
  mode: 'manual' | 'yolo';
}

/**
 * Narrow a CreateGoal tool frame into the goal card's render data. The
 * engine's `goal_start` display payload is the preferred source; raw input
 * args are the fallback.
 */
export function resolveGoalDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display'>,
): GoalDisplay | undefined {
  if (frame.name !== 'CreateGoal') return undefined;
  let input = frame.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  const args =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const display = frame.display as
    | { kind?: unknown; objective?: unknown; completionCriterion?: unknown; mode?: unknown }
    | undefined;
  const objective =
    display?.kind === 'goal_start' && typeof display.objective === 'string'
      ? display.objective
      : typeof args?.['objective'] === 'string'
        ? args['objective']
        : undefined;
  if (objective === undefined) return undefined;
  const criterion =
    display?.kind === 'goal_start' && typeof display.completionCriterion === 'string'
      ? display.completionCriterion
      : typeof args?.['completionCriterion'] === 'string'
        ? args['completionCriterion']
        : undefined;
  const rawMode = display?.kind === 'goal_start' ? display.mode : args?.['mode'];
  return { objective, completionCriterion: criterion, mode: rawMode === 'yolo' ? 'yolo' : 'manual' };
}
