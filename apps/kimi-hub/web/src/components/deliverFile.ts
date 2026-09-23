import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface DeliverFileDisplay {
  path?: string;
  fileId?: string;
  name?: string;
  mediaType?: string;
  size?: number;
}

function argsOf(input: unknown): Record<string, unknown> | undefined {
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
 * Narrow a DeliverFile tool frame into render data. The path headline comes
 * from the engine's `file_io/read` display payload (resolved absolute path)
 * with the raw args as fallback; the file handle (`file_id` + name + size)
 * only exists in the tool RESULT JSON, so a still-running frame degrades to a
 * path-only card. A non-JSON output (the tool reported an error) yields
 * `undefined` so the generic tool frame keeps the error text visible.
 */
export function resolveDeliverFileDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display' | 'output'>,
): DeliverFileDisplay | undefined {
  if (frame.name !== 'DeliverFile') return undefined;
  const args = argsOf(frame.input);
  const display = frame.display as
    | { kind?: unknown; operation?: unknown; path?: unknown }
    | undefined;
  const path =
    display?.kind === 'file_io' && display.operation === 'read' && typeof display.path === 'string'
      ? display.path
      : typeof args?.['path'] === 'string'
        ? args['path']
        : undefined;
  if (frame.output === undefined) return { path };
  const result = argsOf(frame.output);
  if (result === undefined || typeof result['file_id'] !== 'string') return undefined;
  return {
    path,
    fileId: result['file_id'],
    name: typeof result['name'] === 'string' ? result['name'] : undefined,
    mediaType: typeof result['media_type'] === 'string' ? result['media_type'] : undefined,
    size: typeof result['size'] === 'number' ? result['size'] : undefined,
  };
}

export function formatDeliverSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
