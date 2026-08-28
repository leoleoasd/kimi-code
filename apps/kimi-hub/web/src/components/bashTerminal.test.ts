import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { resolveBashDisplay } from './bashTerminal';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'Bash',
    state: 'done',
    ...overrides,
  };
}

describe('resolveBashDisplay', () => {
  it('takes command and cwd from the command display payload', () => {
    const display = resolveBashDisplay(
      frame({
        display: { kind: 'command', command: 'cargo build', cwd: '/repo', language: 'bash' },
      }),
    );
    expect(display).toEqual({ command: 'cargo build', cwd: '/repo' });
  });

  it('falls back to the input args when the display payload is missing', () => {
    const display = resolveBashDisplay(frame({ input: { command: 'ls', timeout: 120 } }));
    expect(display).toEqual({ command: 'ls', cwd: undefined });
  });

  it('parses mid-stream JSON-string input', () => {
    const display = resolveBashDisplay(frame({ input: '{"command":"ls"}' }));
    expect(display).toEqual({ command: 'ls', cwd: undefined });
  });

  it('ignores non-Bash tools and frames without a command', () => {
    expect(resolveBashDisplay(frame({ name: 'TaskOutput' }))).toBeUndefined();
    expect(resolveBashDisplay(frame({ input: { task_id: 'x' } }))).toBeUndefined();
    expect(resolveBashDisplay(frame({ input: '{"command":' }))).toBeUndefined();
  });
});
