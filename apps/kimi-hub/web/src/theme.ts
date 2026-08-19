/**
 * Light/dark theme for the hub web UI.
 *
 * The UI is written dark-first (Tailwind palette classes tuned for a dark
 * page); light mode remaps the palette's CSS variables at runtime (see
 * `index.css` `[data-theme='light']`), so theming is one `data-theme`
 * attribute on `<html>` plus the `theme-color` meta. The choice persists in
 * localStorage; with nothing stored the OS preference wins. The anti-flash
 * boot script in `index.html` mirrors `readInitialTheme` — keep them in sync.
 */

import { useCallback, useState } from 'react';

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'kimi-hub.theme';

/** Browser chrome / splash color per theme (the `theme-color` meta). */
const META_THEME_COLOR: Record<Theme, string> = { dark: '#0b0d10', light: '#ffffff' };

/** A valid stored choice always wins; otherwise follow the OS. */
export function resolveInitialTheme(stored: string | null, systemPrefersLight: boolean): Theme {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemPrefersLight ? 'light' : 'dark';
}

export function readInitialTheme(): Theme {
  try {
    return resolveInitialTheme(
      localStorage.getItem(THEME_STORAGE_KEY),
      window.matchMedia('(prefers-color-scheme: light)').matches,
    );
  } catch {
    // localStorage/matchMedia unavailable (privacy modes) — keep the dark default.
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', META_THEME_COLOR[theme]);
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; the attribute flip still applies.
      }
      applyTheme(next);
      return next;
    });
  }, []);
  return { theme, toggleTheme };
}
