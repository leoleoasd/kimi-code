/**
 * PromptQueueStrip row building — pure and headless: snippet trimming to the
 * 40-char budget, active-first ordering, and tolerance for empty / absent
 * input. The DOM side is not covered (this package has no component-test
 * harness).
 */

import { describe, expect, it } from 'vitest';

import type { PromptQueueItem } from '#/sessions/api';
import { appendQueuedEntry, buildQueueStripRows, queueSnippet } from '#/components/PromptQueueStrip';

function item(promptId: string, text: string): PromptQueueItem {
  return { promptId, status: 'queued', text };
}

describe('queueSnippet', () => {
  it('passes short text through, whitespace collapsed', () => {
    expect(queueSnippet('add tests')).toBe('add tests');
    expect(queueSnippet('  line one\nline\t two  ')).toBe('line one line two');
  });

  it('trims long text to the 40-char budget INCLUDING the ellipsis', () => {
    const long = 'x'.repeat(100);
    const snippet = queueSnippet(long);
    expect(snippet).toHaveLength(40);
    expect(snippet).toBe(`${'x'.repeat(39)}…`);
    // Exactly at the budget: untouched, no ellipsis.
    expect(queueSnippet('y'.repeat(40))).toBe('y'.repeat(40));
  });

  it('empty and whitespace-only input yield an empty snippet', () => {
    expect(queueSnippet('')).toBe('');
    expect(queueSnippet('  \n ')).toBe('');
  });
});

describe('buildQueueStripRows', () => {
  it('renders the queued FIFO in server order; the running prompt is not a row (Stop handles that)', () => {
    const rows = buildQueueStripRows({
      queued: [item('p-1', 'first'), item('p-2', 'second'), item('p-3', 'third')],
    });
    expect(rows.map((r) => r.promptId)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(rows.map((r) => r.label)).toEqual(['queued · first', 'queued · second', 'queued · third']);
    expect(rows[0]?.abortTitle).toBe('drop this queued prompt');
    expect(rows.map((r) => r.key)).toEqual(['queued:p-1', 'queued:p-2', 'queued:p-3']);
  });

  it('tolerates an absent or empty queued list', () => {
    expect(buildQueueStripRows({})).toEqual([]);
    expect(buildQueueStripRows({ queued: [] })).toEqual([]);
    const rows = buildQueueStripRows({ queued: [item('p-2', 'later')] });
    expect(rows.map((r) => r.label)).toEqual(['queued · later']);
  });

  it('a text-less prompt gets a bare status label (no dangling separator)', () => {
    const rows = buildQueueStripRows({ queued: [item('p-2', '  ')] });
    expect(rows.map((r) => r.label)).toEqual(['queued']);
  });
});

describe('appendQueuedEntry (optimistic display)', () => {
  it('starts the queue from an empty cache', () => {
    expect(appendQueuedEntry(undefined, item('p-1', 'typed'))).toEqual({
      active: null,
      queued: [item('p-1', 'typed')],
    });
  });

  it('appends after the already-cached entries in receipt order', () => {
    const seeded = appendQueuedEntry(undefined, item('p-1', 'first'));
    expect(appendQueuedEntry(seeded, item('p-2', 'second')).queued).toEqual([
      item('p-1', 'first'),
      item('p-2', 'second'),
    ]);
  });

  it('preserves the active slot when the cache already has one', () => {
    const active = { promptId: 'p-9', status: 'running' as const, text: 'working' };
    const merged = appendQueuedEntry({ active, queued: [] }, item('p-1', 'x'));
    expect(merged.active).toEqual(active);
  });
});
