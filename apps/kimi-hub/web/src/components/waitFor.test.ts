/**
 * WaitFor card narrowing: the flat (non-expandable) one-liner shows which
 * task the call awaits and its timeout; anything else falls through to the
 * generic tool card.
 */

import { describe, expect, it } from 'vitest';

import { resolveWaitForDisplay } from './waitFor';

const JSON_TIMEOUT = { task_id: 'bash-abc123', timeout: 600 };

describe('resolveWaitForDisplay', () => {
  it('ignores other tools', () => {
    expect(resolveWaitForDisplay({ name: 'TaskOutput', input: '{"task_id":"bash-abc123"}' })).toBeUndefined();
    expect(resolveWaitForDisplay({ name: 'TaskStop', input: '{"task_id":"bash-abc123"}' })).toBeUndefined();
  });

  it('reads task_id + timeout from a JSON-string input', () => {
    expect(resolveWaitForDisplay({ name: 'WaitFor', input: JSON.stringify(JSON_TIMEOUT) })).toEqual({
      taskId: 'bash-abc123',
      timeoutSec: 600,
    });
  });

  it('reads task_id + timeout from an already-parsed object', () => {
    expect(resolveWaitForDisplay({ name: 'WaitFor', input: JSON_TIMEOUT })).toEqual({
      taskId: 'bash-abc123',
      timeoutSec: 600,
    });
  });

  it('a wait-for-any call (no task_id) stays a card, just without a target', () => {
    expect(resolveWaitForDisplay({ name: 'WaitFor', input: '{"timeout":60}' })).toEqual({
      taskId: undefined,
      timeoutSec: 60,
    });
  });

  it('tolerates unparseable / odd input — still narrows, fields undefined', () => {
    expect(resolveWaitForDisplay({ name: 'WaitFor', input: '{broken' })).toEqual({
      taskId: undefined,
      timeoutSec: undefined,
    });
    expect(resolveWaitForDisplay({ name: 'WaitFor', input: 42 })).toEqual({
      taskId: undefined,
      timeoutSec: undefined,
    });
  });
});
