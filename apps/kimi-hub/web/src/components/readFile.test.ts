import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { readParamsText, resolveReadDisplay } from './readFile';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'Read',
    state: 'done',
    ...overrides,
  };
}

describe('resolveReadDisplay', () => {
  it('prefers the resolved path from the display payload', () => {
    const display = resolveReadDisplay(
      frame({
        display: { kind: 'file_io', operation: 'read', path: '/abs/a.rs' },
        input: { path: 'a.rs', line_offset: 206, n_lines: 15 },
      }),
    );
    expect(display).toEqual({ path: '/abs/a.rs', lineOffset: 206, nLines: 15 });
  });

  it('falls back to the input args path', () => {
    expect(resolveReadDisplay(frame({ input: { path: 'b.rs' } }))).toEqual({
      path: 'b.rs',
      lineOffset: undefined,
      nLines: undefined,
    });
  });

  it('parses JSON-string input', () => {
    expect(resolveReadDisplay(frame({ input: '{"path":"c.rs","n_lines":10}' }))).toEqual({
      path: 'c.rs',
      lineOffset: undefined,
      nLines: 10,
    });
  });

  it('ignores non-Read tools and frames without any path', () => {
    expect(resolveReadDisplay(frame({ name: 'Bash' }))).toBeUndefined();
    expect(resolveReadDisplay(frame({ input: '{"path":' }))).toBeUndefined();
    expect(resolveReadDisplay(frame({}))).toBeUndefined();
  });
});

describe('readParamsText', () => {
  it('omits the default whole-file read', () => {
    expect(readParamsText({ path: 'a' })).toBeUndefined();
    expect(readParamsText({ path: 'a', lineOffset: 1 })).toBeUndefined();
  });

  it('renders offset and length', () => {
    expect(readParamsText({ path: 'a', lineOffset: 206, nLines: 15 })).toBe(
      'from line 206 · 15 lines',
    );
    expect(readParamsText({ path: 'a', nLines: 40 })).toBe('40 lines');
  });
});
