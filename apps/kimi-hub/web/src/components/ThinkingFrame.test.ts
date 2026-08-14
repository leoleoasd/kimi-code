import { describe, expect, it } from 'vitest';

import { thinkingTailLines } from './ThinkingFrame';

describe('thinkingTailLines', () => {
  it('returns the full text when it has at most two lines', () => {
    expect(thinkingTailLines('one')).toBe('one');
    expect(thinkingTailLines('one\ntwo')).toBe('one\ntwo');
  });

  it('returns only the last two lines of longer thinking', () => {
    expect(thinkingTailLines('a\nb\nc\nd')).toBe('c\nd');
  });

  it('trims trailing whitespace before slicing, but keeps interior blank lines', () => {
    expect(thinkingTailLines('a\n\nc\n\n')).toBe('\nc');
    expect(thinkingTailLines('a\nb\nc \n')).toBe('b\nc');
  });

  it('returns empty for blank thinking', () => {
    expect(thinkingTailLines('')).toBe('');
    expect(thinkingTailLines('\n\n  ')).toBe('');
  });

  it('streams: the slice follows the growing text', () => {
    expect(thinkingTailLines('a\nb\npartial-line')).toBe('b\npartial-line');
  });
});
