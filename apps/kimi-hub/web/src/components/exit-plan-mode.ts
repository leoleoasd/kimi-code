/**
 * ExitPlanMode tool-frame → rendered display model. The frame's `input` /
 * `output` are open envelopes (a JSON args object and a plain-text result
 * following the engine's string protocol), so this module is the single
 * place that knows the protocol — mirrored on the TUI's parsing in
 * `apps/kimi-code/src/tui/components/messages/tool-call.ts`:
 *
 *   - Approved output starts 'Exited plan mode.' ('Selected approach: X' when
 *     the review picker offered options) or 'User approved option "X".';
 *     the plan body rides behind '## Approved Plan:' — or behind
 *     '## Plan (auto-approved, not user-reviewed):' when auto permission mode
 *     skipped the review ask. Plan-file mode may add 'Plan saved to: <path>'.
 *   - Rejected output starts 'Plan rejected by user.' or 'User rejected the
 *     plan.' ('… Feedback:\n\n<text>' carries the reviewer's note).
 *
 * Plan text resolution order matches the TUI (`resolvePlanForPreview`):
 * inline `input.plan`, the approved-plan marker in the output, then the
 * server-side recovery entry (`transcript/plan` — covers plan-file mode,
 * where the args carry no plan).
 */

import type { ToolCallFrame } from '@moonshot-ai/transcript';

const APPROVED_PLAN_MARKER = '## Approved Plan:';
const AUTO_APPROVED_PLAN_MARKER = '## Plan (auto-approved, not user-reviewed):';

const REJECT_PREFIX = 'User rejected the plan.';
const REJECT_FEEDBACK_PREFIX = 'User rejected the plan. Feedback:';
const PLAN_REJECT_PREFIX = 'Plan rejected by user.';
const APPROVED_OPTION_RE = /^User approved option "([^"]+)"\./;
const SELECTED_APPROACH_RE = /^Exited plan mode\. Selected approach: ([^\n]+)\n/;

export interface ExitPlanDisplay {
  /** Resolved plan markdown; '' when no source yielded one. */
  readonly plan: string;
  readonly outcome: 'pending' | 'approved' | 'auto_approved' | 'rejected';
  /** The review picker's chosen option label, when the output names one. */
  readonly chosen?: string;
  /** The reviewer's note on a rejection, when present. */
  readonly feedback?: string;
}

function outputText(frame: ToolCallFrame): string {
  return typeof frame.output === 'string' ? frame.output : '';
}

function extractApprovedPlan(output: string): string {
  const marker = output.includes(AUTO_APPROVED_PLAN_MARKER)
    ? AUTO_APPROVED_PLAN_MARKER
    : APPROVED_PLAN_MARKER;
  const markerIndex = output.indexOf(marker);
  if (markerIndex < 0) return '';
  return output.slice(markerIndex + marker.length).trim();
}

function inlinePlan(input: unknown): string {
  if (typeof input === 'string') {
    // Mid-stream the args can arrive as unparsed text.
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return '';
    }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '';
  const plan = (input as Record<string, unknown>)['plan'];
  return typeof plan === 'string' ? plan.trim() : '';
}

function outcomeOf(
  output: string,
): Pick<ExitPlanDisplay, 'outcome' | 'chosen' | 'feedback'> {
  if (output.startsWith(REJECT_PREFIX)) {
    if (output.startsWith(REJECT_FEEDBACK_PREFIX)) {
      const feedback = output.slice(REJECT_FEEDBACK_PREFIX.length).trim();
      return feedback === ''
        ? { outcome: 'rejected' }
        : { outcome: 'rejected', feedback };
    }
    return { outcome: 'rejected' };
  }
  if (output.startsWith(PLAN_REJECT_PREFIX)) {
    return { outcome: 'rejected' };
  }
  if (output.includes(AUTO_APPROVED_PLAN_MARKER)) {
    return { outcome: 'auto_approved' };
  }
  if (
    output.startsWith('Exited plan mode.') ||
    output.includes(APPROVED_PLAN_MARKER) ||
    APPROVED_OPTION_RE.test(output)
  ) {
    const chosen = (SELECTED_APPROACH_RE.exec(output) ?? APPROVED_OPTION_RE.exec(output))?.[1];
    return chosen !== undefined ? { outcome: 'approved', chosen } : { outcome: 'approved' };
  }
  return { outcome: 'pending' };
}

export function resolveExitPlanDisplay(
  frame: ToolCallFrame,
  recoveredPlan?: string,
): ExitPlanDisplay {
  const output = outputText(frame);
  const base = outcomeOf(output);
  const plan =
    inlinePlan(frame.input) || extractApprovedPlan(output) || (recoveredPlan ?? '').trim();
  return { plan, ...base };
}
