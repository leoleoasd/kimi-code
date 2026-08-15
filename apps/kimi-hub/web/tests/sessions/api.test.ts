/**
 * The prompt-queue REST surface (`GET …/prompts` + `POST …/prompts/{pid}:abort`):
 * hand-validated normalization of the engine-owned `{ active, queued }` shape,
 * and the idempotent 40903 (prompt.already_completed) accept-code on abort.
 * Wire shape: kap-server's rest-prompt.ts.
 */

import { describe, expect, it } from 'vitest';

import { EnvelopeError } from '#/http';
import { abortQueuedPrompt, fetchPromptQueue } from '#/sessions/api';

const ENDPOINT = { baseUrl: 'http://hub.example.com/agents/a1', token: 'tok' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function queueFetch(calls: string[], body: unknown): typeof fetch {
  return async (input) => {
    calls.push(requestUrl(input));
    return jsonResponse({ code: 0, msg: 'ok', data: body });
  };
}

const ACTIVE = {
  prompt_id: 'p-1',
  user_message_id: 'u-1',
  status: 'running',
  content: [{ type: 'text', text: 'rewrite the parser' }],
  created_at: '2026-08-13T00:00:00.000Z',
};

const QUEUED = {
  prompt_id: 'p-2',
  user_message_id: 'u-2',
  status: 'queued',
  content: [
    { type: 'text', text: 'then' },
    { type: 'image', source: { kind: 'url', url: 'https://example.com/x.png' } },
    { type: 'text', text: 'add tests' },
  ],
  created_at: '2026-08-13T00:00:01.000Z',
};

describe('fetchPromptQueue', () => {
  it('normalizes active + queued, joining text parts (media parts skipped)', async () => {
    const calls: string[] = [];
    const queue = await fetchPromptQueue({
      ...ENDPOINT,
      sessionId: 's 1',
      fetchImpl: queueFetch(calls, { active: ACTIVE, queued: [QUEUED] }),
    });
    expect(calls[0]).toBe(
      'http://hub.example.com/agents/a1/api/v1/sessions/s%201/prompts',
    );
    expect(queue).toEqual({
      active: { promptId: 'p-1', status: 'running', text: 'rewrite the parser' },
      queued: [{ promptId: 'p-2', status: 'queued', text: 'then add tests' }],
    });
  });

  it('an idle session is { active: null, queued: [] }', async () => {
    const queue = await fetchPromptQueue({
      ...ENDPOINT,
      sessionId: 's1',
      fetchImpl: queueFetch([], { active: null, queued: [] }),
    });
    expect(queue).toEqual({ active: null, queued: [] });
  });

  it('a media-only prompt yields an empty text snippet source', async () => {
    const mediaOnly = {
      ...QUEUED,
      content: [{ type: 'image', source: { kind: 'file', file_id: 'f-1' } }],
    };
    const queue = await fetchPromptQueue({
      ...ENDPOINT,
      sessionId: 's1',
      fetchImpl: queueFetch([], { active: null, queued: [mediaOnly] }),
    });
    expect(queue.queued[0]?.text).toBe('');
  });

  it('drops malformed entries, keeps the well-formed ones', async () => {
    const queue = await fetchPromptQueue({
      ...ENDPOINT,
      sessionId: 's1',
      fetchImpl: queueFetch([], {
        active: { bogus: true },
        queued: [{ prompt_id: 7 }, QUEUED, null],
      }),
    });
    expect(queue.active).toBeNull();
    expect(queue.queued).toEqual([{ promptId: 'p-2', status: 'queued', text: 'then add tests' }]);
  });

  it('throws on a body that is not the queue shape at all', async () => {
    await expect(
      fetchPromptQueue({ ...ENDPOINT, sessionId: 's1', fetchImpl: queueFetch([], null) }),
    ).rejects.toThrow('prompt queue: unexpected response shape');
    await expect(
      fetchPromptQueue({
        ...ENDPOINT,
        sessionId: 's1',
        fetchImpl: queueFetch([], { items: [] }),
      }),
    ).rejects.toThrow('prompt queue: unexpected response shape');
  });

  it('appends ?agent_id= when a specific agent queue is requested', async () => {
    const calls: string[] = [];
    await fetchPromptQueue({
      ...ENDPOINT,
      sessionId: 's 1',
      agentId: 'sub agent',
      fetchImpl: queueFetch(calls, { active: null, queued: [] }),
    });
    expect(calls[0]).toBe(
      'http://hub.example.com/agents/a1/api/v1/sessions/s%201/prompts?agent_id=sub%20agent',
    );
  });
});

describe('abortQueuedPrompt', () => {
  it('posts to the pid:abort path and accepts the plain success envelope', async () => {
    const calls: string[] = [];
    await abortQueuedPrompt({
      ...ENDPOINT,
      sessionId: 's 1',
      promptId: 'p/2',
      fetchImpl: async (input) => {
        calls.push(requestUrl(input));
        return jsonResponse({ code: 0, msg: 'ok', data: { aborted: true } });
      },
    });
    expect(calls[0]).toBe(
      'http://hub.example.com/agents/a1/api/v1/sessions/s%201/prompts/p%2F2:abort',
    );
  });

  it('accepts 40903 prompt.already_completed as a no-op success', async () => {
    await expect(
      abortQueuedPrompt({
        ...ENDPOINT,
        sessionId: 's1',
        promptId: 'p-2',
        fetchImpl: async () =>
          jsonResponse({
            code: 40903,
            msg: 'prompt already completed',
            data: { aborted: false },
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects any other business error code', async () => {
    await expect(
      abortQueuedPrompt({
        ...ENDPOINT,
        sessionId: 's1',
        promptId: 'p-2',
        fetchImpl: async () => jsonResponse({ code: 40404, msg: 'prompt not found', data: null }),
      }),
    ).rejects.toThrow(EnvelopeError);
  });

  it('appends ?agent_id= so the abort reaches the owning agent queue', async () => {
    const calls: string[] = [];
    await abortQueuedPrompt({
      ...ENDPOINT,
      sessionId: 's 1',
      promptId: 'p 2',
      agentId: 'sub2',
      fetchImpl: async (input) => {
        calls.push(requestUrl(input));
        return jsonResponse({ code: 0, msg: 'ok', data: { aborted: true } });
      },
    });
    expect(calls[0]).toBe(
      'http://hub.example.com/agents/a1/api/v1/sessions/s%201/prompts/p%202:abort?agent_id=sub2',
    );
  });
});
