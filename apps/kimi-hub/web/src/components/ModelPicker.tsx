/**
 * `/model` picker dialog — opens above the composer when the bare `/model`
 * command is submitted (Enter), the page-side stand-in for the TUI's model
 * dialog (which cannot render over the hub: bare `/model` would pop the
 * host's screen instead).
 *
 * Every model row carries its OWN thinking-effort segments
 * (`sessions/thinking.ts`, a port of the TUI selector's rules): clicking a
 * row — or Enter — applies { model, draftEffort }; clicking any effort chip
 * applies that model+effort directly. ↑/↓ move the highlight, ←/→ step the
 * highlighted row's draft effort, Esc closes. All key decisions are pure
 * (`planPickerKey`) for headless coverage.
 */

import type { ModelChoice } from '#/sessions/api';
import { commitDraftEffort, draftEffortFor, effortLabel, segmentsFor } from '#/sessions/thinking';

export type PickerKeyAction =
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'effort'; readonly delta: 1 | -1 }
  | { readonly kind: 'apply' }
  | { readonly kind: 'close' }
  | { readonly kind: 'none' };

/**
 * What a keydown does while the picker is open (call ONLY when open — the
 * picker wins over the command-hint popover and the Esc-abort binding):
 * ArrowUp/Down move the highlight, ArrowLeft/Right step its draft effort,
 * Enter applies the highlighted row, Escape closes.
 */
export function planPickerKey(event: {
  readonly key: string;
  readonly isComposing?: boolean;
}): PickerKeyAction {
  if (event.isComposing === true) return { kind: 'none' };
  switch (event.key) {
    case 'ArrowDown':
      return { kind: 'move', delta: 1 };
    case 'ArrowUp':
      return { kind: 'move', delta: -1 };
    case 'ArrowRight':
      return { kind: 'effort', delta: 1 };
    case 'ArrowLeft':
      return { kind: 'effort', delta: -1 };
    case 'Enter':
      return { kind: 'apply' };
    case 'Escape':
      return { kind: 'close' };
    default:
      return { kind: 'none' };
  }
}

export function ModelPicker({
  models,
  currentModel,
  currentEffort,
  active,
  effortDrafts,
  disabled,
  onApply,
  onClose,
}: {
  models: readonly ModelChoice[];
  /** Live bound alias / effort of the session's main agent (marks the current row). */
  currentModel?: string | undefined;
  currentEffort?: string | undefined;
  /** Highlighted row index into `models` (caller clamps on shrink). */
  active: number;
  /** Per-alias draft-effort overrides from ←/→ stepping. */
  effortDrafts: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** Apply { model, effort } — the caller persists and closes the dialog. */
  onApply: (model: string, effort: string) => void;
  onClose: () => void;
}) {
  const draftOf = (model: ModelChoice): string =>
    draftEffortFor(model, {
      override: effortDrafts[model.id],
      liveEffort: model.id === currentModel ? currentEffort : undefined,
    });
  return (
    <div
      className="absolute right-3 bottom-full left-3 z-10 mb-1 max-h-72 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 shadow-lg"
      role="dialog"
      aria-label="model picker"
    >
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1.5">
        <span className="text-[11px] text-neutral-400">
          Select a model{' '}
          <span className="text-neutral-600">↑↓ move · ←→ thinking · Enter apply · Esc close</span>
        </span>
        <button
          type="button"
          aria-label="close model picker"
          className="rounded px-1.5 py-0.5 text-[12px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {models.map((model, index) => {
        const isActive = index === active;
        const isCurrent = model.id === currentModel;
        const segments = segmentsFor(model);
        const draft = draftOf(model);
        return (
          <div key={model.id} className={isActive ? 'bg-neutral-800/60' : ''}>
            <button
              type="button"
              role="option"
              aria-selected={isActive}
              disabled={disabled}
              className={`flex w-full items-baseline gap-2 px-3 pt-2 text-left disabled:opacity-50 ${
                isActive ? '' : 'hover:bg-neutral-800/40'
              }`}
              onClick={() => {
                onApply(model.id, commitDraftEffort(model, draft));
              }}
            >
              <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-200">
                {model.label}
              </span>
              {isCurrent ? <span className="shrink-0 text-[11px] text-green-400">✓</span> : null}
            </button>
            {segments.length > 1 ? (
              // EVERY row shows its own segments — not just the highlighted
              // one — so all model/effort combinations are one click away.
              <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
                <span className="text-[10px] text-neutral-600">thinking</span>
                {segments.map((segment) => (
                  <button
                    key={segment}
                    type="button"
                    disabled={disabled}
                    className={`rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-50 ${
                      segment === draft
                        ? 'border-sky-700 bg-sky-900/50 text-sky-300'
                        : 'border-neutral-700 text-neutral-400 hover:border-neutral-500'
                    }`}
                    onClick={() => {
                      onApply(model.id, commitDraftEffort(model, segment));
                    }}
                  >
                    {effortLabel(segment)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
