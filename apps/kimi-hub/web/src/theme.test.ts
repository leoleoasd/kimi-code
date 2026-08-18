import { describe, expect, it } from 'vitest';

import { resolveInitialTheme } from '#/theme';

describe('resolveInitialTheme', () => {
  it('prefers a valid stored choice over the OS preference', () => {
    expect(resolveInitialTheme('light', false)).toBe('light');
    expect(resolveInitialTheme('dark', true)).toBe('dark');
  });

  it('falls back to the OS preference when nothing valid is stored', () => {
    expect(resolveInitialTheme(null, true)).toBe('light');
    expect(resolveInitialTheme(null, false)).toBe('dark');
    expect(resolveInitialTheme('solarized', true)).toBe('light');
    expect(resolveInitialTheme('', false)).toBe('dark');
  });
});
