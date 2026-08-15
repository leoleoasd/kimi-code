/**
 * TodoListPanel row building — the agent's todo doc flattens to ordered rows
 * with per-status markers; the panel hides itself while empty. The DOM side
 * is not covered (this package has no component-test harness).
 */

import { describe, expect, it } from 'vitest';

import type { TranscriptTodo } from '@moonshot-ai/transcript';

import { buildTodoRows } from '#/components/TodoListPanel';

function doc(todoId: string, items: { title: string; status: TranscriptTodo['items'][number]['status'] }[]): TranscriptTodo {
  return { todoId, items };
}

describe('buildTodoRows', () => {
  it('flattens the todo doc into keyed rows in item order', () => {
    const rows = buildTodoRows(
      new Map([
        [
          'todo',
          doc('todo', [
            { title: 'add tests', status: 'in_progress' },
            { title: 'land the PR', status: 'pending' },
          ]),
        ],
      ]),
    );
    expect(rows).toEqual([
      { key: 'todo:0', title: 'add tests', status: 'in_progress' },
      { key: 'todo:1', title: 'land the PR', status: 'pending' },
    ]);
  });

  it('an empty doc and an empty map both collapse to nothing (the panel hides)', () => {
    expect(buildTodoRows(new Map())).toEqual([]);
    expect(buildTodoRows(new Map([['todo', doc('todo', [])]]))).toEqual([]);
  });

  it('merges multiple docs in map order', () => {
    const rows = buildTodoRows(
      new Map([
        ['todo', doc('todo', [{ title: 'one', status: 'done' }])],
        ['extra', doc('extra', [{ title: 'two', status: 'pending' }])],
      ]),
    );
    expect(rows.map((row) => row.key)).toEqual(['todo:0', 'extra:0']);
  });
});
