import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { buildDiffRows, resolveEditDiffDisplay } from './editDiff';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'Edit',
    state: 'done',
    ...overrides,
  };
}

describe('resolveEditDiffDisplay', () => {
  it('takes before/after from the file_io edit display payload', () => {
    const display = resolveEditDiffDisplay(
      frame({
        display: {
          kind: 'file_io',
          operation: 'edit',
          path: '/repo/a.ts',
          before: 'const a = 1;',
          after: 'const a = 2;',
        },
      }),
    );
    expect(display).toEqual({ path: '/repo/a.ts', before: 'const a = 1;', after: 'const a = 2;' });
  });

  it('falls back to the input args when the display payload is missing', () => {
    const display = resolveEditDiffDisplay(
      frame({
        input: { path: '/repo/b.ts', old_string: 'x', new_string: 'y', replace_all: false },
      }),
    );
    expect(display).toEqual({ path: '/repo/b.ts', before: 'x', after: 'y' });
  });

  it('parses mid-stream JSON-string input', () => {
    const display = resolveEditDiffDisplay(
      frame({ input: JSON.stringify({ path: '/repo/c.ts', old_string: 'x', new_string: 'y' }) }),
    );
    expect(display).toEqual({ path: '/repo/c.ts', before: 'x', after: 'y' });
  });

  it('ignores non-Edit tools and edits without both sides', () => {
    expect(resolveEditDiffDisplay(frame({ name: 'MultiEdit' }))).toBeUndefined();
    expect(resolveEditDiffDisplay(frame({ input: { old_string: 'x' } }))).toBeUndefined();
    expect(resolveEditDiffDisplay(frame({ input: '{"old_string":' }))).toBeUndefined();
  });
});

describe('buildDiffRows', () => {
  it('marks removed and added lines around untouched context', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nB\nc');
    expect(rows).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('treats a trailing newline as no change of its own', () => {
    expect(buildDiffRows('a\n', 'a')).toEqual([{ type: 'context', text: 'a' }]);
  });

  it('collapses long unchanged runs, keeping context lines on both edges', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
    const after = before.replace('line20', 'LINE20');
    const rows = buildDiffRows(before, after);
    const collapses = rows.filter((r) => r.type === 'collapse');
    // two clusters of context (lines 0–19 and 21–39), each collapsed to its edges
    expect(collapses.map((c) => c.lines.length)).toEqual([14, 13]);
    expect(rows.filter((r) => r.type === 'context')).toHaveLength(12);
    expect(rows).toContainEqual({ type: 'del', text: 'line20' });
    expect(rows).toContainEqual({ type: 'add', text: 'LINE20' });
  });

  it('keeps short unchanged runs fully expanded', () => {
    const rows = buildDiffRows('a\nb\nc', 'a\nb\nC');
    expect(rows.every((r) => r.type !== 'collapse')).toBe(true);
  });
});
