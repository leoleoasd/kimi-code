import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface BashDisplay {
  command: string;
  cwd?: string;
}

/**
 * Narrow a Bash tool frame into terminal render data. Preferred source is the
 * engine's `command` display payload; the raw input args (`command`) are the
 * fallback for records whose display never landed.
 */
export function resolveBashDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display'>,
): BashDisplay | undefined {
  if (frame.name !== 'Bash') return undefined;
  const display = frame.display as
    | { kind?: unknown; command?: unknown; cwd?: unknown }
    | undefined;
  if (display?.kind === 'command' && typeof display.command === 'string') {
    return {
      command: display.command,
      cwd: typeof display.cwd === 'string' ? display.cwd : undefined,
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
  if (typeof record['command'] !== 'string') return undefined;
  return { command: record['command'] };
}
