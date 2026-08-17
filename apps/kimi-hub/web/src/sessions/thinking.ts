/**
 * Thinking-effort model: which effort segments a model offers and which one a
 * fresh selection commits by default.
 *
 * This is a deliberate PORT of the TUI model selector's rules
 * (apps/kimi-code/src/tui/components/dialogs/model-selector.ts —
 * thinkingAvailability / segmentsFor / defaultThinkingEffortFor /
 * commitEffort) onto the hub web's catalog shape (`ModelChoice` in
 * sessions/api.ts), so the web popup and the TUI dialog offer the same
 * segments for the same model and never send an effort the engine would
 * reject. Keep the two in sync when the TUI rules move.
 */

export interface ThinkingModelInfo {
  readonly capabilities?: readonly string[];
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export type ThinkingAvailability = 'toggle' | 'always-on' | 'unsupported';

export function thinkingAvailability(model: ThinkingModelInfo): ThinkingAvailability {
  const caps = model.capabilities ?? [];
  if (caps.includes('always_thinking')) return 'always-on';
  if (caps.includes('thinking')) return 'toggle';
  return 'unsupported';
}

/**
 * Ordered selectable efforts for a model. Effort-capable models expose their
 * declared efforts (with an 'off' entry when the model is not always-on);
 * legacy boolean models expose 'on'/'off'; single-segment lists mean the
 * control is effectively locked.
 */
export function segmentsFor(model: ThinkingModelInfo): readonly string[] {
  const efforts = model.supportEfforts ?? [];
  const availability = thinkingAvailability(model);
  if (efforts.length > 0) {
    return availability === 'always-on' ? efforts : ['off', ...efforts];
  }
  if (availability === 'always-on') return ['on'];
  if (availability === 'unsupported') return ['off'];
  return ['on', 'off'];
}

/**
 * Default effort for a model: declared `defaultEffort`, else the middle
 * `supportEfforts` entry, else 'on' for boolean models, 'off' when thinking
 * is unsupported.
 */
export function defaultThinkingEffortFor(model: ThinkingModelInfo): string {
  if (thinkingAvailability(model) === 'unsupported') return 'off';
  const efforts = model.supportEfforts ?? [];
  if (efforts.length > 0) {
    return model.defaultEffort ?? efforts[Math.floor(efforts.length / 2)]!;
  }
  return 'on';
}

/**
 * The effort the picker's APPLY actually commits for a model: a UI draft of
 * 'on' never leaks past the boundary — it becomes the model's default effort
 * (a concrete effort for effort-capable models, 'on' only for genuine boolean
 * models).
 */
export function commitDraftEffort(model: ThinkingModelInfo, draft: string): string {
  if (draft === 'on') return defaultThinkingEffortFor(model);
  return draft;
}

/**
 * A model's picker draft effort: the user's arrow-key override when set, else
 * the LIVE effort for the currently bound model, else the model default.
 * Coerced onto the segment list so rendering/committal never reference an
 * effort the model cannot select.
 */
export function draftEffortFor(
  model: ThinkingModelInfo,
  opts: { override?: string; liveEffort?: string },
): string {
  const segments = segmentsFor(model);
  const draft = opts.override ?? opts.liveEffort ?? defaultThinkingEffortFor(model);
  return segments.includes(draft) ? draft : segments[0]!;
}

export function effortLabel(effort: string): string {
  if (effort.length === 0) return effort;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
