import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface ReadDisplay {
  path?: string;
  lineOffset?: number;
  nLines?: number;
}

/**
 * Narrow a Read tool frame into render data: the path comes from the engine's
 * `file_io/read` display payload first (the resolved absolute path) with the
 * raw input args as fallback; the paging parameters only exist in the args.
 */
export function resolveReadDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display'>,
): ReadDisplay | undefined {
  if (frame.name !== 'Read') return undefined;
  let input = frame.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  const args =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const display = frame.display as
    | { kind?: unknown; operation?: unknown; path?: unknown }
    | undefined;
  const path =
    display?.kind === 'file_io' && display.operation === 'read' && typeof display.path === 'string'
      ? display.path
      : typeof args?.['path'] === 'string'
        ? args['path']
        : undefined;
  if (path === undefined) return undefined;
  return {
    path,
    lineOffset: typeof args?.['line_offset'] === 'number' ? args['line_offset'] : undefined,
    nLines: typeof args?.['n_lines'] === 'number' ? args['n_lines'] : undefined,
  };
}

/** Compact params note for the header: "from line 206 · 15 lines". */
export function readParamsText(display: ReadDisplay): string | undefined {
  const parts: string[] = [];
  if (display.lineOffset !== undefined && display.lineOffset !== 1) {
    parts.push(`from line ${display.lineOffset}`);
  }
  if (display.nLines !== undefined) parts.push(`${display.nLines} lines`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}
