import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface WriteDisplay {
  path?: string;
  content: string;
}

/**
 * Narrow a Write tool frame into render data. Preferred source is the
 * engine's `file_io/write` display payload (`content`); the raw input args
 * (`path`/`content`) are the fallback for records whose display never landed.
 */
export function resolveWriteDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display'>,
): WriteDisplay | undefined {
  if (frame.name !== 'Write') return undefined;
  const display = frame.display as
    | { kind?: unknown; operation?: unknown; path?: unknown; content?: unknown }
    | undefined;
  if (display?.kind === 'file_io' && display.operation === 'write' && typeof display.content === 'string') {
    return {
      path: typeof display.path === 'string' ? display.path : undefined,
      content: display.content,
    };
  }
  let input = frame.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record['content'] !== 'string') return undefined;
  return {
    path: typeof record['path'] === 'string' ? record['path'] : undefined,
    content: record['content'],
  };
}
