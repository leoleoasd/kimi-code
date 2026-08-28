import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { resolveWriteDisplay } from './writeFile';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'Write',
    state: 'done',
    ...overrides,
  };
}

describe('resolveWriteDisplay', () => {
  it('takes path and content from the file_io write display payload', () => {
    const display = resolveWriteDisplay(
      frame({
        display: {
          kind: 'file_io',
          operation: 'write',
          path: '/tmp/a.toml',
          content: '[package]\n',
        },
      }),
    );
    expect(display).toEqual({ path: '/tmp/a.toml', content: '[package]\n' });
  });

  it('falls back to the input args when the display payload is missing', () => {
    const display = resolveWriteDisplay(frame({ input: { path: '/tmp/b.md', content: 'hi' } }));
    expect(display).toEqual({ path: '/tmp/b.md', content: 'hi' });
  });

  it('parses mid-stream JSON-string input', () => {
    const display = resolveWriteDisplay(frame({ input: '{"content":"x","path":"/c"}' }));
    expect(display).toEqual({ path: '/c', content: 'x' });
  });

  it('ignores non-Write tools and frames without content', () => {
    expect(resolveWriteDisplay(frame({ name: 'Edit' }))).toBeUndefined();
    expect(resolveWriteDisplay(frame({ input: { path: '/tmp/x' } }))).toBeUndefined();
    expect(resolveWriteDisplay(frame({ input: '{"content":' }))).toBeUndefined();
  });
});
