/**
 * Slash-command hint popover (composer autocomplete): typing `/` opens the
 * candidate list above the composer; it filters by the first-token prefix,
 * ArrowUp/Down cycles, Tab/Enter fills, Escape closes (which ALSO takes
 * precedence over the pane-level "Esc aborts the turn" binding while open —
 * popover dismiss always wins).
 *
 * Click a row to fill the composer with the command's primary word (and a
 * trailing space when its grammar takes arguments). All decisions are pure
 * (`commandHints` / `planHintKey` / `fillFor`) for headless coverage.
 */

import { LOCAL_COMMANDS } from '#/sessions/commands';
import type { SessionCommandInfo } from '#/sessions/api';

export interface HintCandidate {
  readonly usage: string;
  readonly description: string;
  /** The primary slash word to fill on select. */
  readonly primary: string;
  /** Every word that matches the typed prefix (primary + aliases). */
  readonly matchWords: readonly string[];
  /** Whether a fill should append a space for the grammar's argument. */
  readonly needsArg: boolean;
}

/**
 * The popover's candidate pool: the agent's bridge catalog (the connected
 * TUI's registry — source of truth) plus the two browser-local commands.
 * An unavailable catalog (headless agent, offline fallback) just leaves the
 * local pair.
 */
export function hintSource(catalog: readonly SessionCommandInfo[]): readonly HintCandidate[] {
  return [
    ...catalog.map((row) => ({
      usage: row.usage,
      description: row.description ?? '',
      primary: `/${row.name}`,
      matchWords: [row.name, ...row.aliases],
      needsArg: row.usage.indexOf(' ') !== -1,
    })),
    ...LOCAL_COMMANDS.map((row) => ({
      usage: row.usage,
      description: row.description,
      primary: row.usage,
      matchWords: [row.usage.slice(1)],
      needsArg: false,
    })),
  ];
}

/**
 * Candidates for a composer's `input`: only runs while the COMMAND WORD is
 * being typed — `input` starts with `/` and carries NO whitespace yet. Once
 * an argument starts (`/goal 1…` or even `/abort `) the command word is no
 * longer updatable and the popover closes: Enter must SEND, not accept.
 */
export function commandHints(
  input: string,
  source: readonly HintCandidate[],
): readonly HintCandidate[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const word = input.slice(1);
  return source.filter((candidate) => candidate.matchWords.some((name) => name.startsWith(word)));
}

export type HintKeyAction =
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'accept' }
  | { readonly kind: 'close' }
  | { readonly kind: 'none' };

/**
 * What a keydown does while the popover is open (call AFTER computing the open
 * state; only call when open):
 *  - ArrowDown/ArrowUp/Tab wrap through candidates (Tab also wraps);
 *  - Enter accepts the active candidate;
 *  - Escape closes — the caller Swallows it BEFORE any abort binding.
 */
export function planHintKey(event: {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
}): HintKeyAction {
  if (event.isComposing === true) return { kind: 'none' };
  switch (event.key) {
    case 'ArrowDown':
      return { kind: 'move', delta: 1 };
    case 'ArrowUp':
      return { kind: 'move', delta: -1 };
    case 'Tab':
    case 'Enter':
      return { kind: 'accept' };
    case 'Escape':
      return { kind: 'close' };
    default:
      return { kind: 'none' };
  }
}

/** The replaced composer text after accepting a candidate. */
export function fillFor(candidate: HintCandidate): string {
  return candidate.needsArg ? `${candidate.primary} ` : candidate.primary;
}

export function CommandHint({
  active,
  candidates,
  onAccept,
}: {
  /** Index into `candidates` — the caller clamps it when the list shrinks. */
  active: number;
  candidates: readonly HintCandidate[];
  onAccept: (candidate: HintCandidate) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      className="absolute bottom-full left-3 right-3 z-10 mb-1 max-h-56 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 shadow-lg"
      role="listbox"
      aria-label="command hints"
    >
      {candidates.map((candidate, index) => (
        <button
          key={candidate.primary}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`flex w-full items-baseline gap-3 px-3 py-2 text-left ${
            index === active ? 'bg-neutral-800/80' : 'hover:bg-neutral-800/40'
          }`}
          onClick={() => {
            onAccept(candidate);
          }}
        >
          <span className="shrink-0 font-mono text-[12px] text-sky-300">{candidate.usage}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">
            {candidate.description}
          </span>
        </button>
      ))}
    </div>
  );
}
