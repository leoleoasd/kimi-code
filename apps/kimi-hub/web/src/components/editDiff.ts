import { diffLines } from 'diff';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

export interface EditDiffDisplay {
  path?: string;
  before: string;
  after: string;
}

/**
 * Narrow an Edit tool frame into diff render data. Preferred source is the
 * engine's `file_io/edit` display payload (`before`/`after`); the raw input
 * args (`old_string`/`new_string`) are the fallback for records whose display
 * never landed.
 */
export function resolveEditDiffDisplay(
  frame: Pick<ToolCallFrame, 'name' | 'input' | 'display'>,
): EditDiffDisplay | undefined {
  if (frame.name !== 'Edit') return undefined;
  const display = frame.display as
    | { kind?: unknown; operation?: unknown; path?: unknown; before?: unknown; after?: unknown }
    | undefined;
  if (
    display?.kind === 'file_io' &&
    display.operation === 'edit' &&
    typeof display.before === 'string' &&
    typeof display.after === 'string'
  ) {
    return {
      path: typeof display.path === 'string' ? display.path : undefined,
      before: display.before,
      after: display.after,
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
  if (typeof record['old_string'] !== 'string' || typeof record['new_string'] !== 'string') {
    return undefined;
  }
  return {
    path: typeof record['path'] === 'string' ? record['path'] : undefined,
    before: record['old_string'],
    after: record['new_string'],
  };
}

export type DiffRow =
  | { type: 'context' | 'add' | 'del'; text: string }
  | { type: 'collapse'; lines: string[] };

/**
 * Line-level git-style diff of before → after. Long unchanged runs collapse
 * into a `collapse` row that keeps `context` lines on each edge of the change
 * cluster, so a 600-line rewrite with a two-line change stays scannable.
 */
export function buildDiffRows(before: string, after: string, context = 3): DiffRow[] {
  const flat: { type: 'context' | 'add' | 'del'; text: string }[] = [];
  for (const part of diffLines(before, after, { ignoreNewlineAtEof: true })) {
    const type = part.added === true ? 'add' : part.removed === true ? 'del' : 'context';
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const text of lines) flat.push({ type, text });
  }
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < flat.length) {
    const row = flat[i]!;
    if (row.type !== 'context') {
      rows.push(row);
      i += 1;
      continue;
    }
    let end = i;
    while (end < flat.length && flat[end]!.type === 'context') end += 1;
    const run = flat.slice(i, end).map((r) => r.text);
    if (run.length > context * 2 + 1) {
      for (const text of run.slice(0, context)) rows.push({ type: 'context', text });
      rows.push({ type: 'collapse', lines: run.slice(context, run.length - context) });
      for (const text of run.slice(run.length - context)) rows.push({ type: 'context', text });
    } else {
      for (const text of run) rows.push({ type: 'context', text });
    }
    i = end;
  }
  return rows;
}
