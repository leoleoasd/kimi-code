/**
 * `/model` popup picker — opens above the composer while the input is exactly
 * `/model` (or `/model <filter>`), the page-level replacement for the TUI's
 * interactive model dialog (which cannot render over the hub: bare `/model`
 * would pop the host's screen instead).
 *
 * Rows come from the agent's catalog (`GET /api/v1/models`); the highlighted
 * row expands the model's thinking-effort segments (`sessions/thinking.ts`,
 * a port of the TUI selector's rules). Clicking a row — or Enter — applies
 * { model, draftEffort } in one profile write; clicking an effort chip applies
 * that effort directly. ↑/↓ move the highlight, ←/→ step the highlighted
 * row's draft effort, Esc closes (and clears) the composer input. All
 * decisions are pure (`modelPickerQuery` / `filterModels` / `planPickerKey`)
 * for headless coverage.
 */

import type { ModelChoice } from '#/sessions/api';
import { commitDraftEffort, draftEffortFor, effortLabel, segmentsFor } from '#/sessions/thinking';

/**
 * Parse the composer input into the picker's open state. Open while the input
 * is exactly `/model` or `/model <anything>` — the tail is the fuzzy filter.
 * `null` = the composer is not in model-picker mode at all.
 */
export function modelPickerQuery(input: string): { filter: string } | null {
  if (input === '/model') return { filter: '' };
  if (input.startsWith('/model ')) return { filter: input.slice('/model '.length) };
  return null;
}

/** Case-insensitive substring filter over the alias, label, and provider. */
export function filterModels(
  models: readonly ModelChoice[],
  filter: string,
): readonly ModelChoice[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return models;
  return models.filter((model) =>
    `${model.id} ${model.label} ${model.provider}`.toLowerCase().includes(needle),
  );
}

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
  /** The filter is ALREADY applied by the caller (`filterModels`). */
  models: readonly ModelChoice[];
  /** Live bound alias / effort of the session's main agent (marks the current row). */
  currentModel?: string | undefined;
  currentEffort?: string | undefined;
  /** Highlighted row index into `models` (caller clamps on shrink). */
  active: number;
  /** Per-alias draft-effort overrides from ←/→ stepping. */
  effortDrafts: Readonly<Record<string, string>>;
  disabled?: boolean;
  /** Apply { model, effort } — the caller persists and closes the picker. */
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
          Select a model <span className="text-neutral-600">↑↓ move · ←→ thinking · Enter apply · Esc close</span>
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
      {models.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-neutral-600 italic">No matching models</div>
      ) : (
        models.map((model, index) => {
          const isActive = index === active;
          const isCurrent = model.id === currentModel;
          const segments = segmentsFor(model);
          const draft = draftOf(model);
          return (
            <div key={model.id}>
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={disabled}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left disabled:opacity-50 ${
                  isActive ? 'bg-neutral-800/80' : 'hover:bg-neutral-800/40'
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
              {isActive && segments.length > 1 ? (
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
        })
      )}
    </div>
  );
}
