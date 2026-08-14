/**
 * Thinking frame: streaming display, collapsed by default to the LAST TWO
 * lines (the TUI parity rule) with a one-tap expand to the full text.
 *
 * Why two lines and not zero: a fully-collapsed thinking block hides the
 * signal users actually want mid-turn (what the model is reasoning about
 * right now). The trailing lines cover that without eating the timeline.
 */

import { useState } from 'react';

/** The trailing display slice of a thinking block: split on hard newlines. */
export function thinkingTailLines(text: string, lines = 2): string {
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed === '') return '';
  const parts = trimmed.split('\n');
  return parts.slice(-lines).join('\n');
}

export function ThinkingFrame({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const body = expanded ? text : thinkingTailLines(text);
  const canExpand = body !== text;
  return (
    <div className="mb-2 max-w-full rounded border border-dashed border-neutral-700/70 px-3 py-1.5 sm:max-w-[92%]">
      <button
        type="button"
        className="w-full cursor-pointer text-left text-[10px] text-neutral-600 select-none hover:text-neutral-400 disabled:cursor-default disabled:hover:text-neutral-600"
        onClick={() => setExpanded((value) => !value)}
        disabled={!canExpand}
      >
        thinking{streaming ? ' …' : ''}{expanded ? ' ▾' : canExpand ? ' ▸' : ''}
      </button>
      <div className="mt-1 font-mono text-[11px] whitespace-pre-wrap text-neutral-500">
        {body}
        {streaming ? (
          <span className="stream-caret ml-0.5 inline-block h-3 w-[5px] translate-y-0.5 bg-neutral-500" />
        ) : null}
      </div>
    </div>
  );
}
