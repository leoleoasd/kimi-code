/**
 * The engine-owned prompt queue, mirrored from `GET …/prompts`: one compact
 * chip per QUEUED prompt in FIFO order. The in-flight turn itself is NOT a
 * row — its abort lives on the composer's Stop button / Esc, so the strip
 * stays symmetric: "what runs next".
 *
 * A chip's ✕ drops just that prompt (`prompts/{pid}:abort`). The chip body
 * opens a small menu with the two repositioning actions: EDIT recalls the
 * text into the composer (abort the queued entry, load the text back, fix,
 * resend — the TUI's recall-last-queued); STEER pulls the prompt out of the
 * FIFO into the ACTIVE turn at its next step boundary (`prompts/{pid}:steer`,
 * offered only while a turn is actually running). Hidden whenever there is
 * nothing queued; the 2s poll in ChatView drains it after the engine moves on.
 *
 * Row building is pure (`buildQueueStripRows` / `queueSnippet`) so the logic
 * stays headless — this package has no component-test harness.
 */

import { useState } from 'react';

import type { PromptQueue, PromptQueueItem } from '#/sessions/api';

export interface QueueStripRow {
  readonly key: string;
  readonly promptId: string;
  /** `"queued · <snippet>"` (bare `queued` when the prompt has no text). */
  readonly label: string;
  /** Full prompt text — what the menu's Edit action recalls into the composer. */
  readonly text: string;
  readonly abortTitle: string;
  readonly menuTitle: string;
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
      menuTitle: 'edit or steer this queued prompt',
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
  onSteerQueued,
}: {
  /** undefined while the first poll is in flight — the strip stays hidden. */
  queue: PromptQueue | undefined;
  onAbortQueued: (promptId: string) => void;
  onRecallQueued: (promptId: string, text: string) => void;
  onSteerQueued: (promptId: string) => void;
}) {
  /** The chip whose action menu is open (by promptId); null = closed. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const rows = buildQueueStripRows({ queued: queue?.queued });
  if (rows.length === 0) return null;
  // Steer needs a live turn to merge into; without one the server rejects.
  const steerable = queue !== undefined && queue.active !== null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2 lg:px-4" aria-label="prompt queue">
      {rows.map((row) => (
        <div
          key={row.key}
          className="relative flex max-w-full items-center rounded-full border border-neutral-800 bg-neutral-900/60 text-[11px] text-neutral-500"
        >
          <button
            type="button"
            title={row.menuTitle}
            className="min-w-0 truncate rounded-l-full py-1 pl-2.5 pr-1.5 hover:bg-neutral-800/60 hover:text-neutral-300"
            onClick={() => {
              setMenuFor((current) => (current === row.promptId ? null : row.promptId));
            }}
          >
            {row.label}
          </button>
          <button
            type="button"
            title={row.abortTitle}
            className="shrink-0 rounded-r-full py-1 pl-1 pr-2.5 text-neutral-600 hover:bg-neutral-800/60 hover:text-neutral-300"
            onClick={() => {
              setMenuFor(null);
              onAbortQueued(row.promptId);
            }}
          >
            <span aria-hidden>✕</span>
          </button>
          {menuFor === row.promptId ? (
            <>
              {/* Outside-click/tap dismiss (mobile-first: a full-viewport
                  transparent layer under the menu). */}
              <button
                type="button"
                aria-label="close the queue menu"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => {
                  setMenuFor(null);
                }}
              />
              <div
                role="menu"
                className="absolute left-0 top-full z-20 mt-1 min-w-36 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-[12px] text-neutral-300 hover:bg-neutral-800/60"
                  title="drop from the queue and load back into the composer"
                  onClick={() => {
                    setMenuFor(null);
                    onRecallQueued(row.promptId, row.text);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!steerable}
                  className="block w-full px-3 py-2 text-left text-[12px] text-neutral-300 hover:bg-neutral-800/60 disabled:opacity-40"
                  title={
                    steerable
                      ? 'inject into the running turn at its next step boundary'
                      : 'no running turn to steer into'
                  }
                  onClick={() => {
                    setMenuFor(null);
                    onSteerQueued(row.promptId);
                  }}
                >
                  Steer into the running turn
                </button>
              </div>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
