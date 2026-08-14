/**
 * Thinking frame: streaming display, collapsed by default to the LAST TWO
 * visual rows of the text, with a one-tap expand to the full text.
 *
 * The collapsed box is a fixed two-row window (`h-8` = 2 × `leading-4`)
 * whose content is bottom-anchored with top overflow clipped — no string
 * slicing and no -webkit-line-clamp: a "logical" line wraps to up to 4–5
 * rows on narrow screens, so the LAST two visual rows of the stream are
 * always what shows, on any device width, and the surrounding layout never
 * shifts while streaming.
 *
 * Why two lines and not zero: a fully-collapsed thinking block hides the
 * signal users actually want mid-turn (what the model is reasoning about
 * right now). The trailing rows cover that without eating the timeline.
 */

import { useLayoutEffect, useRef, useState } from 'react';

export function ThinkingFrame({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // Measured clipping: the collapsed window truncates visually (wrapped
  // rows), which simple line counting cannot predict — offer expand only
  // when the bottom-anchored content block really overruns the window.
  const clampRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = clampRef.current;
    setClipped(el !== null && el.offsetHeight > 2 * 16 + 1);
  }, [text, expanded]);
  const canExpand = expanded || clipped;
  const body = expanded ? text : text.replace(/\s+$/, '');
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
      <div
        className={
          expanded
            ? 'mt-1 font-mono text-[11px] leading-4 whitespace-pre-wrap text-neutral-500'
            : 'mt-1 relative h-8 overflow-hidden font-mono text-[11px] leading-4 text-neutral-500'
        }
      >
        <div
          ref={expanded ? undefined : clampRef}
          className={expanded ? undefined : 'absolute inset-x-0 bottom-0 whitespace-pre-wrap'}
        >
          {body}
          {streaming ? (
            <span className="stream-caret ml-0.5 inline-block h-3 w-[5px] translate-y-0.5 bg-neutral-500" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
