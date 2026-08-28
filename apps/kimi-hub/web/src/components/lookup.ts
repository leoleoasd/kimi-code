import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface LookupDisplay {
  tool: 'Glob' | 'Grep' | 'FetchURL' | 'WebSearch';
  /** The one-line subject: glob/grep pattern, fetched URL, search query. */
  headline: string;
  /** Muted scope note: grep/glob search path, URL method, search scope. */
  scope?: string;
  /** Present for FetchURL only — the headline renders as a tappable link. */
  url?: string;
}

function parseArgs(input: unknown): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Narrow the lookup-style tools (Glob / Grep / FetchURL / WebSearch) into a
 * headline + scope pair for the collapsed lookup card. The engine's display
 * payload is the preferred source; raw input args are the fallback.
 */
export function resolveLookupDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display'>,
): LookupDisplay | undefined {
  const args = parseArgs(frame.input);
  const display = frame.display as
    | {
        kind?: unknown;
        operation?: unknown;
        path?: unknown;
        query?: unknown;
        url?: unknown;
        method?: unknown;
        scope?: unknown;
      }
    | undefined;
  switch (frame.name) {
    case 'Glob': {
      const pattern = typeof args?.['pattern'] === 'string' ? args['pattern'] : undefined;
      if (pattern === undefined) return undefined;
      const path =
        display?.kind === 'file_io' && display.operation === 'glob' && typeof display.path === 'string'
          ? display.path
          : typeof args?.['path'] === 'string'
            ? args['path']
            : undefined;
      return { tool: 'Glob', headline: pattern, scope: path };
    }
    case 'Grep': {
      const pattern = typeof args?.['pattern'] === 'string' ? args['pattern'] : undefined;
      if (pattern === undefined) return undefined;
      const path =
        display?.kind === 'file_io' && display.operation === 'grep' && typeof display.path === 'string'
          ? display.path
          : typeof args?.['path'] === 'string'
            ? args['path']
            : undefined;
      const glob = typeof args?.['glob'] === 'string' ? args['glob'] : undefined;
      const scope = [path, glob !== undefined ? `(${glob})` : undefined]
        .filter((v): v is string => v !== undefined)
        .join(' ');
      return { tool: 'Grep', headline: pattern, scope: scope === '' ? undefined : scope };
    }
    case 'FetchURL': {
      const url =
        display?.kind === 'url_fetch' && typeof display.url === 'string'
          ? display.url
          : typeof args?.['url'] === 'string'
            ? args['url']
            : undefined;
      if (url === undefined) return undefined;
      const method =
        display?.kind === 'url_fetch' && typeof display.method === 'string'
          ? display.method
          : undefined;
      return { tool: 'FetchURL', headline: url, scope: method, url };
    }
    case 'WebSearch': {
      const query =
        display?.kind === 'search' && typeof display.query === 'string'
          ? display.query
          : typeof args?.['query'] === 'string'
            ? args['query']
            : undefined;
      if (query === undefined) return undefined;
      const scope =
        display?.kind === 'search' && typeof display.scope === 'string' ? display.scope : undefined;
      return { tool: 'WebSearch', headline: query, scope };
    }
    default:
      return undefined;
  }
}

/** Non-empty line count of a result body — the collapsed header's size hint. */
export function resultLineCount(output: unknown): number | undefined {
  if (typeof output !== 'string' || output === '') return undefined;
  return output.split('\n').filter((line) => line.trim() !== '').length;
}
