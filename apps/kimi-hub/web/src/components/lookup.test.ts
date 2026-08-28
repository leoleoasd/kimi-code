import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { resolveLookupDisplay, resultLineCount } from './lookup';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'Glob',
    state: 'done',
    ...overrides,
  };
}

describe('resolveLookupDisplay', () => {
  it('resolves Glob from args with the display path as scope', () => {
    const display = resolveLookupDisplay(
      frame({
        display: { kind: 'file_io', operation: 'glob', path: '/repo/src' },
        input: { pattern: '**/*.ts', path: 'src' },
      }),
    );
    expect(display).toEqual({ tool: 'Glob', headline: '**/*.ts', scope: '/repo/src', url: undefined });
  });

  it('resolves Grep combining path and glob filter into the scope', () => {
    const display = resolveLookupDisplay(
      frame({
        name: 'Grep',
        display: { kind: 'file_io', operation: 'grep', path: '/repo/src' },
        input: { pattern: 'TODO', path: 'src', glob: '*.ts' },
      }),
    );
    expect(display).toEqual({ tool: 'Grep', headline: 'TODO', scope: '/repo/src (*.ts)', url: undefined });
  });

  it('resolves FetchURL from the display payload with a non-default method note', () => {
    const display = resolveLookupDisplay(
      frame({ name: 'FetchURL', display: { kind: 'url_fetch', url: 'https://a.dev/x', method: 'POST' } }),
    );
    expect(display).toEqual({ tool: 'FetchURL', headline: 'https://a.dev/x', scope: 'POST', url: 'https://a.dev/x' });
  });

  it('resolves FetchURL from plain args', () => {
    const display = resolveLookupDisplay(frame({ name: 'FetchURL', input: { url: 'https://a.dev' } }));
    expect(display).toEqual({ tool: 'FetchURL', headline: 'https://a.dev', scope: undefined, url: 'https://a.dev' });
  });

  it('resolves WebSearch from the search display payload', () => {
    const display = resolveLookupDisplay(
      frame({ name: 'WebSearch', display: { kind: 'search', query: 'kimi hub' } }),
    );
    expect(display).toEqual({ tool: 'WebSearch', headline: 'kimi hub', scope: undefined, url: undefined });
  });

  it('parses JSON-string input and skips tools without a subject', () => {
    expect(
      resolveLookupDisplay(frame({ name: 'WebSearch', input: '{"query":"x"}' })),
    ).toEqual({ tool: 'WebSearch', headline: 'x', scope: undefined, url: undefined });
    expect(resolveLookupDisplay(frame({ name: 'Bash' }))).toBeUndefined();
    expect(resolveLookupDisplay(frame({ input: {} }))).toBeUndefined();
    expect(resolveLookupDisplay(frame({ name: 'FetchURL', input: '{"url":' }))).toBeUndefined();
  });
});

describe('resultLineCount', () => {
  it('counts non-empty lines and skips empty output', () => {
    expect(resultLineCount('a\n\nb\nc')).toBe(3);
    expect(resultLineCount('')).toBeUndefined();
    expect(resultLineCount({ files: [] })).toBeUndefined();
  });
});
