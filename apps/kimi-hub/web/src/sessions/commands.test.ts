/**
 * Composer slash-command routing — any `/…` line forwards verbatim to the
 * agent's command bridge; only `/copy` and `/export-debug-zip` stay local.
 * The runner half (`runComposerCommand`) doubles as the api-helper coverage:
 * it drives the actions over an envelope-level fake `fetchImpl`, the same
 * mocking style as files.test.ts.
 */

import { describe, expect, it } from 'vitest';

import type { TranscriptItem } from '@moonshot-ai/transcript';

import {
  lastAssistantText,
  parseComposerCommand,
  runComposerCommand,
  type CommandContext,
} from './commands';

describe('parseComposerCommand', () => {
  it('passes non-command input through as a prompt', () => {
    expect(parseComposerCommand('hello world')).toBeNull();
    expect(parseComposerCommand('')).toBeNull();
    expect(parseComposerCommand('explain what /abort does')).toBeNull();
  });

  it('keeps bare /copy browser-local', () => {
    expect(parseComposerCommand('/copy')).toEqual({ kind: 'action', action: { kind: 'copy' } });
  });

  it('keeps bare /export-debug-zip browser-local', () => {
    expect(parseComposerCommand('/export-debug-zip')).toEqual({
      kind: 'action',
      action: { kind: 'export-debug-zip' },
    });
  });

  it('classifies /btw as page-local, bare or with a first message', () => {
    expect(parseComposerCommand('/btw')).toEqual({ kind: 'action', action: { kind: 'btw' } });
    expect(parseComposerCommand('/btw ')).toEqual({ kind: 'action', action: { kind: 'btw' } });
    expect(parseComposerCommand('/btw hello there')).toEqual({
      kind: 'action',
      action: { kind: 'btw', text: 'hello there' },
    });
    // Lookalike prefixes stay remote — only the exact word owns the route.
    expect(parseComposerCommand('/btwfoo hi')).toEqual({
      kind: 'action',
      action: { kind: 'remote', input: '/btwfoo hi' },
    });
  });

  it('forwards every other slash-prefixed line verbatim — known words included', () => {
    for (const input of ['/abort', '/yolo on', '/compact keep the api', '/goal pause', '/restart', '/', '/ABORT']) {
      expect(parseComposerCommand(input)).toEqual({
        kind: 'action',
        action: { kind: 'remote', input },
      });
    }
  });

  it('short-circuits bare dialog commands — /model pops a TUI overlay, never the page', () => {
    const parsed = parseComposerCommand('/model');
    expect(parsed?.kind).toBe('action');
    expect(parsed?.action.kind).toBe('notice');
    if (parsed?.action.kind === 'notice') {
      expect(parsed.action.notice).toContain('model picker');
    }
    // …but an ARG-CARRYING line still forwards: it may head the dialog server-side.
    expect(parseComposerCommand('/model k3-b300')).toEqual({
      kind: 'action',
      action: { kind: 'remote', input: '/model k3-b300' },
    });
  });

  it('never treats a multi-line paste as a command — it goes through as a prompt', () => {
    // The reported case: a pasted comment snippet whose first line begins with '//'.
    const paste =
      '// "host:port" where this rank serves afterglow.events.v1.EventStream\n' +
      '// cache events are enabled; absent otherwise.';
    expect(parseComposerCommand(paste)).toBeNull();
    // Even inputs whose first line IS a known word: multi-line is not a command.
    expect(parseComposerCommand('/copy\nkeep this line')).toBeNull();
    expect(parseComposerCommand('/model\nk3-b300')).toBeNull();
  });
});

/** Envelope-level fake fetch — mirrors files.test.ts: assert the request, reply the envelope. */
function fakeFetch(handler: (req: { method?: string; url: string; body?: string }) => unknown) {
  const calls: { method?: string; url: string; body?: string }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const req = { method: init?.method, url, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(req);
    const data = handler(req);
    return new Response(JSON.stringify({ code: 0, msg: 'ok', data, request_id: 'req-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const CTX = { baseUrl: 'http://hub.test/agents/a1', token: 'tok', sessionId: 'sess-1' };

describe('runComposerCommand — remote forwarding', () => {
  it('POSTs the raw line to :command and joins error+notice lines', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({
      notices: ['YOLO mode: ON', 'tool actions auto-approved'],
      errors: [],
    }));
    const result = await runComposerCommand(
      { kind: 'remote', input: '/yolo on' },
      { ...CTX, fetchImpl },
    );
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'http://hub.test/agents/a1/api/v1/sessions/sess-1:command',
        body: JSON.stringify({ input: '/yolo on' }),
      },
    ]);
    expect(result.notice).toBe('YOLO mode: ON\ntool actions auto-approved');
  });

  it('puts error lines first and yields an empty notice for silent commands', async () => {
    const { fetchImpl } = fakeFetch(() => ({ notices: [], errors: ['unknown slash command'] }));
    const failed = await runComposerCommand({ kind: 'remote', input: '/nope' }, { ...CTX, fetchImpl });
    expect(failed.notice).toBe('unknown slash command');
    const { fetchImpl: silentFetch } = fakeFetch(() => ({ notices: [], errors: [] }));
    const silent = await runComposerCommand(
      { kind: 'remote', input: '/x' },
      { ...CTX, fetchImpl: silentFetch },
    );
    expect(silent.notice).toBe('');
  });
});

describe('runComposerCommand — /btw', () => {
  it('starts the side-channel agent via :btw and hands it to ChatView', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ({ agent_id: 'agent-42' }));
    const result = await runComposerCommand({ kind: 'btw', text: 'ping' }, { ...CTX, fetchImpl });
    expect(calls).toEqual([
      { method: 'POST', url: 'http://hub.test/agents/a1/api/v1/sessions/sess-1:btw', body: '{}' },
    ]);
    expect(result.btw).toEqual({ agentId: 'agent-42', text: 'ping' });
    expect(result.notice).toContain('agent-42');
  });

  it('starts bare — no text rides the result', async () => {
    const { fetchImpl } = fakeFetch(() => ({ agent_id: 'agent-43' }));
    const result = await runComposerCommand({ kind: 'btw' }, { ...CTX, fetchImpl });
    expect(result.btw).toEqual({ agentId: 'agent-43', text: undefined });
  });
});

describe('runComposerCommand — /copy', () => {
  it('writes the last assistant text to the clipboard', async () => {
    const writes: string[] = [];
    const result = await runComposerCommand(
      { kind: 'copy' },
      {
        ...CTX,
        getLastAssistantText: () => 'the answer',
        clipboard: { writeText: async (t) => void writes.push(t) },
      },
    );
    expect(writes).toEqual(['the answer']);
    expect(result.notice).toBe('copied to clipboard (10 characters)');
  });

  it('reports when the transcript holds no assistant text', async () => {
    const result = await runComposerCommand(
      { kind: 'copy' },
      { ...CTX, getLastAssistantText: () => undefined },
    );
    expect(result.notice).toBe('no assistant message to copy');
  });
});

describe('runComposerCommand — /export-debug-zip', () => {
  it('downloads the zip blob under the session-derived filename', async () => {
    const downloads: string[] = [];
    const fetchImpl = (async () =>
      new Response(new Blob(['zip-bytes']), { status: 200 })) as unknown as CommandContext['fetchImpl'];
    const result = await runComposerCommand(
      { kind: 'export-debug-zip' },
      {
        ...CTX,
        fetchImpl,
        download: (_blob, filename) => downloads.push(filename),
      },
    );
    expect(downloads).toEqual(['session-sess-1-export.zip']);
    expect(result.notice).toContain('export complete');
  });
});

// The transcript-fixture half of the old table: unchanged semantics.
describe('lastAssistantText', () => {
  it('returns the newest non-blank assistant text frame', () => {
    const items = [
      {
        kind: 'turn',
        steps: [
          {
            frames: [
              { kind: 'text', role: 'assistant', text: 'older' },
              { kind: 'text', role: 'user', text: 'skipped' },
            ],
          },
        ],
      },
      {
        kind: 'turn',
        steps: [{ frames: [{ kind: 'text', role: 'assistant', text: 'newest' }] }],
      },
    ] as unknown as TranscriptItem[];
    expect(lastAssistantText(items)).toBe('newest');
  });

  it('skips blank frames and missing transcripts', () => {
    expect(lastAssistantText([])).toBeUndefined();
    const blank = [
      { kind: 'turn', steps: [{ frames: [{ kind: 'text', role: 'assistant', text: '  ' }] }] },
    ] as unknown as TranscriptItem[];
    expect(lastAssistantText(blank)).toBeUndefined();
  });
});
