import { describe, expect, it } from 'vitest';

import type { SessionCommandInfo } from '#/sessions/api';

import { commandHints, fillFor, hintSource, planHintKey } from './CommandHint';

const CATALOG: readonly SessionCommandInfo[] = [
  { name: 'abort', aliases: [], usage: '/abort', description: 'Cancel the running turn' },
  { name: 'yolo', aliases: ['yes'], usage: '/yolo [on|off]', description: 'Toggle YOLO mode' },
  {
    name: 'goal',
    aliases: [],
    usage: '/goal <objective>',
    description: 'Start or manage an autonomous goal',
  },
];

const SOURCE = hintSource(CATALOG);

describe('hintSource', () => {
  it('maps catalog rows and always appends the local pair', () => {
    expect(SOURCE.map((c) => c.primary)).toEqual(['/abort', '/yolo', '/goal', '/copy', '/export-debug-zip']);
    const yolo = SOURCE.find((c) => c.primary === '/yolo');
    expect(yolo?.matchWords).toEqual(['yolo', 'yes']);
    expect(yolo?.needsArg).toBe(true);
  });

  it('degrades to the local pair for an empty catalog', () => {
    expect(hintSource([]).map((c) => c.primary)).toEqual(['/copy', '/export-debug-zip']);
  });
});

describe('commandHints', () => {
  it('empty list when the input does not start with /', () => {
    expect(commandHints('hello', SOURCE)).toEqual([]);
    expect(commandHints(' /abort', SOURCE)).toEqual([]);
  });

  it('bare / lists every candidate', () => {
    expect(commandHints('/', SOURCE).map((c) => c.primary)).toEqual(
      SOURCE.map((c) => c.primary),
    );
  });

  it('filters by prefix over names AND aliases, case-sensitively (like the TUI)', () => {
    expect(commandHints('/a', SOURCE).map((c) => c.usage)).toEqual(['/abort']);
    expect(commandHints('/y', SOURCE).map((c) => c.usage)).toEqual(['/yolo [on|off]']);
    expect(commandHints('/ye', SOURCE).map((c) => c.usage)).toEqual(['/yolo [on|off]']);
    expect(commandHints('/G', SOURCE)).toEqual([]);
  });

  it('closes once the argument phase begins — Enter must send, not accept', () => {
    expect(commandHints('/compact keep the api', SOURCE)).toEqual([]);
    expect(commandHints('/goal ', SOURCE)).toEqual([]);
  });
});

describe('planHintKey', () => {
  it('moves up/down, wraps on Tab, accepts on Tab/Enter', () => {
    expect(planHintKey({ key: 'ArrowDown' })).toEqual({ kind: 'move', delta: 1 });
    expect(planHintKey({ key: 'ArrowUp' })).toEqual({ kind: 'move', delta: -1 });
    expect(planHintKey({ key: 'Enter' })).toEqual({ kind: 'accept' });
    expect(planHintKey({ key: 'Tab' })).toEqual({ kind: 'accept' });
  });

  it('closes on Escape and yields nothing mid-IME composition', () => {
    expect(planHintKey({ key: 'Escape' })).toEqual({ kind: 'close' });
    expect(planHintKey({ key: 'Escape', isComposing: true })).toEqual({ kind: 'none' });
    expect(planHintKey({ key: 'ArrowDown', isComposing: true })).toEqual({ kind: 'none' });
  });
});

describe('fillFor', () => {
  it('fills trailing space only when the grammar takes an argument', () => {
    expect(
      fillFor({ usage: '/abort', description: '', primary: '/abort', matchWords: ['abort'], needsArg: false }),
    ).toBe('/abort');
    expect(
      fillFor({
        usage: '/compact [instruction]',
        description: '',
        primary: '/compact',
        matchWords: ['compact'],
        needsArg: true,
      }),
    ).toBe('/compact ');
  });
});
