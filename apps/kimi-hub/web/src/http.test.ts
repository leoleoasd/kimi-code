/**
 * The auth-header contract of the shared envelope client (`getJson` /
 * `postJson`): a real token rides as `Authorization: Bearer <token>`; the
 * EMPTY token (the `--dangerous-bypass-auth` authless sentinel) omits the
 * header ENTIRELY — never `Bearer ` with an empty value, which would parse
 * server-side as a malformed credential.
 */

import { describe, expect, it } from 'vitest';

import { getJson, postJson } from './http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Captured = { headers: Record<string, string> | undefined; cache: string | undefined };

function capturingFetch(calls: Captured[]): typeof fetch {
  return async (_input, init) => {
    calls.push({
      headers: init?.headers as Record<string, string> | undefined,
      cache: init?.cache,
    });
    return jsonResponse({ code: 0, msg: 'ok', data: null });
  };
}

describe('auth header', () => {
  it('sends `Authorization: Bearer <token>` for a real token', async () => {
    const calls: Captured[] = [];
    await getJson({
      baseUrl: 'http://hub.example.com',
      token: 'tok-1',
      path: '/hub/api/agents',
      fetchImpl: capturingFetch(calls),
    });
    expect(calls[0]?.headers?.['authorization']).toBe('Bearer tok-1');
  });

  it('bypasses the HTTP cache — a stale roster must never survive a poll tick', async () => {
    const calls: Captured[] = [];
    await getJson({
      baseUrl: 'http://hub.example.com',
      token: 'tok-1',
      path: '/hub/api/agents',
      fetchImpl: capturingFetch(calls),
    });
    expect(calls[0]?.cache).toBe('no-store');
  });

  it('omits the header entirely for the empty (authless) token — GET and POST', async () => {
    const calls: Captured[] = [];
    const fetchImpl = capturingFetch(calls);
    await getJson({
      baseUrl: 'http://hub.example.com',
      token: '',
      path: '/hub/api/agents',
      fetchImpl,
    });
    await postJson({
      baseUrl: 'http://hub.example.com',
      token: '',
      path: '/api/v1/sessions',
      fetchImpl,
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers).toBeDefined();
      expect(Object.keys(call.headers ?? {})).not.toContain('authorization');
    }
    // The POST keeps its JSON content type — only the credential is dropped.
    expect(calls[1]?.headers?.['content-type']).toBe('application/json');
  });
});
