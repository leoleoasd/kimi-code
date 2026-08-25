import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IMcpOAuthCallbackRegistry, type McpOAuthExternalCallback } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

describe('server-v2 /api/v1/mcp/oauth/callback', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-mcp-oauth-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  function beginFlow(state: string): { received: McpOAuthExternalCallback[] } {
    const box = { received: [] as McpOAuthExternalCallback[] };
    server!.core.accessor.get(IMcpOAuthCallbackRegistry).begin(state, {
      serverName: 'notion',
      deliver: (result) => {
        box.received.push(result);
      },
    });
    return box;
  }

  it('delivers code+state to the pending flow and answers the success page', async () => {
    const flow = beginFlow('state-ok');
    const res = await fetch(`${base}/api/v1/mcp/oauth/callback?code=abc&state=state-ok`, {
      headers: authHeaders(server!),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Sign-in complete');
    expect(flow.received).toEqual([{ code: 'abc' }]);
  });

  it('forwards a provider error to the flow and answers 400 with the error page', async () => {
    const flow = beginFlow('state-denied');
    const res = await fetch(
      `${base}/api/v1/mcp/oauth/callback?error=access_denied&error_description=nope&state=state-denied`,
      { headers: authHeaders(server!) },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Sign-in failed');
    expect(flow.received).toEqual([{ error: 'access_denied: nope' }]);
  });

  it('answers 404 when the state belongs to no pending flow', async () => {
    const res = await fetch(`${base}/api/v1/mcp/oauth/callback?code=abc&state=unknown`, {
      headers: authHeaders(server!),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('No pending sign-in');
  });

  it('answers 400 when the query carries neither code nor error', async () => {
    const res = await fetch(`${base}/api/v1/mcp/oauth/callback?state=state-ok`, {
      headers: authHeaders(server!),
    });
    expect(res.status).toBe(400);
  });

  it('stays behind bearer auth: no token, no delivery', async () => {
    const flow = beginFlow('state-gated');
    const res = await fetch(`${base}/api/v1/mcp/oauth/callback?code=abc&state=state-gated`);
    expect(res.status).toBe(401);
    expect(flow.received).toEqual([]);
  });
});
