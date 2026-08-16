/**
 * The engine-owned prompt queue, mirrored from `GET …/prompts`: one compact
 * chip per QUEUED prompt in FIFO order. The in-flight turn itself is NOT a
 * row — its abort lives on the composer's Stop button / Esc, so the strip
 * stays symmetric: "what runs next".
 *
 * A chip has TWO affordances, not one: the ✕ drops just that prompt
 * (`prompts/{pid}:abort`), the chip body EDITS it — abort the queued entry
 * and load its text back into the composer so the user can fix and resend
 * (the TUI's recall-last-queued). Hidden whenever there is nothing queued;
 * the 2s poll in ChatView drains it after the engine moves on.
 *
 * Row building is pure (`buildQueueStripRows` / `queueSnippet`) so the logic
 * stays headless — this package has no component-test harness.
 */

import type { PromptQueue, PromptQueueItem } from '#/sessions/api';

export interface QueueStripRow {
  readonly key: string;
  readonly promptId: string;
  /** `"queued · <snippet>"` (bare `queued` when the prompt has no text). */
  readonly label: string;
  /** Full prompt text — what chip-click recalls into the composer. */
  readonly text: string;
  readonly abortTitle: string;
  readonly recallTitle: string;
}

/**
 * The one-line snippet: whitespace collapsed, trimmed to `maxChars` total
 * INCLUDING the trailing ellipsis.
 */
export function queueSnippet(text: string, maxChars = 40): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** The queued FIFO in server order. */
export function buildQueueStripRows(queue: {
  readonly queued?: readonly PromptQueueItem[] | null;
}): QueueStripRow[] {
  return (queue.queued ?? []).map((item) => {
    const snippet = queueSnippet(item.text);
    return {
      key: `queued:${item.promptId}`,
      promptId: item.promptId,
      label: snippet === '' ? 'queued' : `queued · ${snippet}`,
      text: item.text,
      abortTitle: 'drop this queued prompt',
      recallTitle: 'edit: drop from the queue and load back into the composer',
    };
  });
}

/**
 * Merge a just-POSTed queued prompt into the cached queue state so the chip
 * shows up the tick the response lands, NOT after the next poll. The poll's
 * next authoritative snapshot replaces this wholesale — ids/text agree from
 * the same server, so no dedupe dance is needed.
 */
export function appendQueuedEntry(
  queue: { readonly active: PromptQueueItem | null | undefined; readonly queued?: readonly PromptQueueItem[] } | undefined,
  item: PromptQueueItem,
): { readonly active: PromptQueueItem | null; readonly queued: readonly PromptQueueItem[] } {
  return { active: queue?.active ?? null, queued: [...(queue?.queued ?? []), item] };
}

export function PromptQueueStrip({
  queue,
  onAbortQueued,
  onRecallQueued,
}: {
  /** undefined while the first poll is in flight — the strip stays hidden. */
  queue: PromptQueue | undefined;
  onAbortQueued: (promptId: string) => void;
  onRecallQueued: (promptId: string, text: string) => void;
}) {
  const rows = buildQueueStripRows({ queued: queue?.queued });
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 lg:px-4" aria-label="prompt queue">
      {rows.map((row) => (
        <div
          key={row.key}
          className="flex max-w-full items-center rounded-full border border-neutral-800 bg-neutral-900/60 text-[11px] text-neutral-500"
        >
          <button
            type="button"
            title={row.recallTitle}
            className="min-w-0 truncate rounded-l-full py-1 pl-2.5 pr-1.5 hover:bg-neutral-800/60 hover:text-neutral-300"
            onClick={() => {
              onRecallQueued(row.promptId, row.text);
            }}
          >
            {row.label}
          </button>
          <button
            type="button"
            title={row.abortTitle}
            className="shrink-0 rounded-r-full py-1 pl-1 pr-2.5 text-neutral-600 hover:bg-neutral-800/60 hover:text-neutral-300"
            onClick={() => {
              onAbortQueued(row.promptId);
            }}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
