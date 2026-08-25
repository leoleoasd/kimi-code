import { afterEach, describe, expect, it, vi } from 'vitest';

import { startCallbackServer } from '#/mcpCore/oauth/callback-server';
import { McpOAuthCallbackRegistryService } from '#/mcpCore/oauth/callbackRegistryService';
import { McpOAuthService } from '#/mcpCore/oauth/service';

import { createMemoryMcpOAuthStore } from '../stubs';

describe('startCallbackServer', () => {
  it('resolves waitForCode from an HTTP GET on the redirect URI', async () => {
    const server = await startCallbackServer();
    const waiting = server.waitForCode({ timeoutMs: 5000 });
    const res = await fetch(`${server.redirectUri}?code=abc&state=s1`);
    expect(res.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'abc', state: 's1' });
  });

  it('queues an external delivery that lands before waitForCode is armed', async () => {
    const server = await startCallbackServer();
    server.deliver({ code: 'early', state: 's2' });
    await expect(server.waitForCode({ timeoutMs: 1000 })).resolves.toEqual({
      code: 'early',
      state: 's2',
    });
  });

  it('queues an external error delivery that lands before waitForCode is armed', async () => {
    const server = await startCallbackServer();
    server.deliverError(new Error('access denied'));
    await expect(server.waitForCode({ timeoutMs: 1000 })).rejects.toThrow('access denied');
  });

  it('rejects waitForCode when the timeout elapses', async () => {
    const server = await startCallbackServer();
    await expect(server.waitForCode({ timeoutMs: 20 })).rejects.toThrow('OAuth callback timed out');
  });

  it('ignores a second delivery after the first settled the flow', async () => {
    const server = await startCallbackServer();
    server.deliver({ code: 'first', state: undefined });
    server.deliver({ code: 'second', state: undefined });
    await expect(server.waitForCode({ timeoutMs: 1000 })).resolves.toEqual({
      code: 'first',
      state: undefined,
    });
  });
});

describe('McpOAuthCallbackRegistryService', () => {
  it('delivers to the flow registered under the state', () => {
    const registry = new McpOAuthCallbackRegistryService();
    const received: unknown[] = [];
    registry.begin('state-a', { serverName: 'notion', deliver: (r) => received.push(r) });
    expect(registry.deliver('state-a', { code: 'c1' })).toBe(true);
    expect(received).toEqual([{ code: 'c1' }]);
  });

  it('returns false for an unknown state and after unregister', () => {
    const registry = new McpOAuthCallbackRegistryService();
    expect(registry.deliver('nope', { code: 'c1' })).toBe(false);
    const unregister = registry.begin('state-b', { serverName: 'x', deliver: () => undefined });
    unregister();
    expect(registry.deliver('state-b', { code: 'c1' })).toBe(false);
  });
});

const SERVER_URL = 'https://mcp.example.test/mcp';
const ISSUER = 'https://mcp.example.test';
const EXTERNAL_REDIRECT = 'https://hub.example.test/agents/agent-1/api/v1/mcp/oauth/callback';

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
};

function stubOAuthProviderFetch(): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (new URL(url).hostname === '127.0.0.1') {
      return realFetch(input as Parameters<typeof globalThis.fetch>[0], init);
    }
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/.well-known/oauth-authorization-server')) {
      return Response.json(METADATA);
    }
    if (method === 'POST' && url === METADATA.registration_endpoint) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return Response.json({ ...body, client_id: 'client-1', client_id_issued_at: 1 });
    }
    if (method === 'POST' && url === METADATA.token_endpoint) {
      return Response.json({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response('not found', { status: 404 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('McpOAuthService with an external (hub) redirect URI', () => {
  it('points the authorization URL at the external URI and completes on a registry delivery', async () => {
    stubOAuthProviderFetch();
    const registry = new McpOAuthCallbackRegistryService();
    const service = new McpOAuthService({ store: createMemoryMcpOAuthStore(), callbackRegistry: registry });

    const flow = await service.beginAuthorization('notion', SERVER_URL, {
      externalRedirectUri: EXTERNAL_REDIRECT,
    });
    expect(flow.authorizationUrl.searchParams.get('redirect_uri')).toBe(EXTERNAL_REDIRECT);
    const state = flow.authorizationUrl.searchParams.get('state');
    expect(state).not.toBeNull();

    expect(registry.deliver(state!, { code: 'auth-code-1' })).toBe(true);
    await expect(flow.complete({ timeoutMs: 5000 })).resolves.toBeUndefined();
    await expect(service.hasTokens('notion', SERVER_URL)).resolves.toBe(true);
  });

  it('resolves complete() when the delivery lands before complete() is called', async () => {
    stubOAuthProviderFetch();
    const registry = new McpOAuthCallbackRegistryService();
    const service = new McpOAuthService({ store: createMemoryMcpOAuthStore(), callbackRegistry: registry });

    const flow = await service.beginAuthorization('notion', SERVER_URL, {
      externalRedirectUri: EXTERNAL_REDIRECT,
    });
    const state = flow.authorizationUrl.searchParams.get('state')!;
    expect(registry.deliver(state, { code: 'auth-code-2' })).toBe(true);
    await expect(flow.complete({ timeoutMs: 5000 })).resolves.toBeUndefined();
  });

  it('propagates a provider error delivery as a flow failure', async () => {
    stubOAuthProviderFetch();
    const registry = new McpOAuthCallbackRegistryService();
    const service = new McpOAuthService({ store: createMemoryMcpOAuthStore(), callbackRegistry: registry });

    const flow = await service.beginAuthorization('notion', SERVER_URL, {
      externalRedirectUri: EXTERNAL_REDIRECT,
    });
    const state = flow.authorizationUrl.searchParams.get('state')!;
    registry.deliver(state, { error: 'access_denied' });
    await expect(flow.complete({ timeoutMs: 5000 })).rejects.toThrow(/access_denied/);
    expect(registry.deliver(state, { code: 'late' })).toBe(false);
  });

  it('keeps the loopback listener flow working when no external URI is given', async () => {
    stubOAuthProviderFetch();
    const registry = new McpOAuthCallbackRegistryService();
    const service = new McpOAuthService({ store: createMemoryMcpOAuthStore(), callbackRegistry: registry });

    const flow = await service.beginAuthorization('notion', SERVER_URL);
    expect(flow.authorizationUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    const state = flow.authorizationUrl.searchParams.get('state');
    expect(registry.deliver('whatever', { code: 'x' })).toBe(false);

    const completing = flow.complete({ timeoutMs: 5000 });
    const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri')!;
    const res = await fetch(`${redirectUri}?code=loop-code&state=${state}`);
    expect(res.status).toBe(200);
    await expect(completing).resolves.toBeUndefined();
  });
});
