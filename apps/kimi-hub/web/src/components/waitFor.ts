import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface WaitForDisplay {
  /** The awaited task; undefined when the call waits for the first task to finish. */
  taskId?: string;
  /** The call's hard timeout, in seconds (always present — the engine requires it). */
  timeoutSec?: number;
}

function parseArgs(input: unknown): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Narrow a WaitFor tool call into whom it waits on (+ its timeout) for the
 * flat one-line card. The card is NOT expandable: a WaitFor result is a
 * opaque task-output snapshot whose substance is the awaited task's own
 * later surface, so there is nothing worth unfolding.
 */
export function resolveWaitForDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input'>,
): WaitForDisplay | undefined {
  if (frame.name !== 'WaitFor') return undefined;
  const args = parseArgs(frame.input);
  const taskId = typeof args?.['task_id'] === 'string' ? args['task_id'] : undefined;
  const timeout = typeof args?.['timeout'] === 'number' ? args['timeout'] : undefined;
  return { taskId, timeoutSec: timeout };
}
