/**
 * The agent's TodoList, mirrored from the transcript contract's `todos` doc —
 * TUI-chrome parity: a compact status row per item, mounted above the
 * composer, hidden while empty. The doc arrives with the REST page AND flows
 * live through `todo.upsert` ops, so no polling belongs here.
 *
 * Row building is pure (`buildTodoRows`); the DOM side stays dumb.
 */

import type { TranscriptTodo } from '@moonshot-ai/transcript';

export interface TodoRow {
  readonly key: string;
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

/**
 * One todo DOC exists per agent transcript (the engine's singleton `todo`
 * id); tolerate extras by merging them in map order, so an irregular doc is
 * shown rather than silently hidden.
 */
export function buildTodoRows(todos: ReadonlyMap<string, TranscriptTodo>): readonly TodoRow[] {
  const rows: TodoRow[] = [];
  for (const doc of todos.values()) {
    doc.items.forEach((item, index) => {
      rows.push({ key: `${doc.todoId}:${String(index)}`, title: item.title, status: item.status });
    });
  }
  return rows;
}

function rowMarker(status: TodoRow['status']): { glyph: string; className: string } {
  switch (status) {
    case 'done':
      return { glyph: '✓', className: 'text-green-500/80' };
    case 'in_progress':
      return { glyph: '◐', className: 'text-amber-400' };
    case 'pending':
      return { glyph: '○', className: 'text-neutral-500' };
  }
}

export function TodoListPanel({ todos }: { todos: ReadonlyMap<string, TranscriptTodo> }) {
  const rows = buildTodoRows(todos);
  if (rows.length === 0) return null;
  const doneCount = rows.filter((row) => row.status === 'done').length;
  return (
    <div className="border-t border-neutral-800/80 px-3 py-1.5 lg:px-4" aria-label="todo list">
      <div className="mb-1 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
        todo · {doneCount}/{rows.length}
      </div>
      <ul className="max-h-28 space-y-0.5 overflow-y-auto">
        {rows.map((row) => {
          const marker = rowMarker(row.status);
          return (
            <li key={row.key} className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
              <span className={`shrink-0 ${marker.className}`} aria-hidden>
                {marker.glyph}
              </span>
              <span
                className={`min-w-0 truncate ${
                  row.status === 'done' ? 'text-neutral-600 line-through' : 'text-neutral-300'
                }`}
                title={row.title}
              >
                {row.title}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
