/**
 * Ordered-list continuity across fragmented lists: chat models split one
 * logical numbered list into many one-item lists (blank lines + interstitial
 * paragraphs between items), and each fragment would render as its own
 * <ol> starting at 1 — the "all 1." wall. `orderedListStarts` numbers the
 * fragments as one list; structural blocks reset the run.
 */

import { describe, expect, it } from 'vitest';

import { orderedListStarts, parseMarkdown } from './Markdown';

function starts(text: string): number[] {
  const blocks = parseMarkdown(text);
  const map = orderedListStarts(blocks);
  return blocks
    .map((block, index) => (block.kind === 'list' && block.ordered ? map.get(index) : undefined))
    .filter((start): start is number => start !== undefined);
}

describe('orderedListStarts', () => {
  it('one tight list keeps its single start of 1', () => {
    expect(starts('1. a\n2. b\n3. c')).toEqual([1]);
  });

  it('lazy "1."-every-item fragments continue 1..N across paragraphs', () => {
    const text = ['1. first', '', '→ why first', 'because reasons', '', '1. second', '', '1. third'].join('\n');
    expect(starts(text)).toEqual([1, 2, 3]);
  });

  it('a multi-item fragment advances the counter by its length', () => {
    const text = ['1. a', '2. b', '', 'note in between', '', '1. c'].join('\n');
    expect(starts(text)).toEqual([1, 3]);
  });

  it('structural blocks reset the run — a later list starts over', () => {
    const text = ['1. a', '', '# heading', '', '1. b', '', '> quote', '', '1. c'].join('\n');
    expect(starts(text)).toEqual([1, 1, 1]);
  });

  it('an unordered list between fragments also resets', () => {
    const text = ['1. a', '', '- bullet', '', '1. b'].join('\n');
    expect(starts(text)).toEqual([1, 1]);
  });

  it('a code fence resets even when it is the only separator', () => {
    const text = ['1. a', '```', 'x', '```', '1. b'].join('\n');
    expect(starts(text)).toEqual([1, 1]);
  });

  it('text with no ordered lists yields no starts', () => {
    expect(starts('plain paragraph\n\n- bullet')).toEqual([]);
  });
});
