import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubConnectionService } from '#/hub/hubConnectionService';

const CONN = {
  hubUrl: 'https://hub.example.com/',
  token: 'hub-token',
  agentName: 'dev-box',
  sessionIds: ['ses-mine'],
};

describe('HubConnectionService', () => {
  let service: HubConnectionService;

  beforeEach(() => {
    service = new HubConnectionService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports no connection before and after being configured', () => {
    expect(service.connection()).toBeUndefined();
    service.configure(CONN);
    expect(service.connection()).toEqual(CONN);
    service.configure(undefined);
    expect(service.connection()).toBeUndefined();
  });

  it('refuses outbound calls while unconfigured', async () => {
    await expect(service.listRemoteAgents()).rejects.toThrow('not connected to a kimi hub');
    await expect(
      service.sendToSession({ agentId: 'a', sessionId: 's', text: 'x' }),
    ).rejects.toThrow('not connected to a kimi hub');
  });

  it('reads the roster with the bearer and flattens scope (legacy agents publish no sessions)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/v2/sessions')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 0,
              msg: 'success',
              data: {
                items: [
                  {
                    id: 'ses-pair',
                    workspace: { id: 'w1', cwd: '/work/kimi-code' },
                    meta: { title: 'pairing session', created_at: 1, updated_at: 2, archived: false },
                    activity: { status: 'idle' },
                  },
                  {
                    id: 'ses-out-of-scope',
                    workspace: { id: 'w1', cwd: '/work/kimi-code' },
                    meta: { title: 'not mine', created_at: 1, updated_at: 2, archived: false },
                    activity: { status: 'idle' },
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              agents: [
                {
                  agentId: 'a1',
                  name: 'dev-box',
                  platform: 'darwin',
                  arch: 'arm64',
                  version: '0.56.1',
                  cwd: '/work/kimi-code',
                  connectedAt: 170_000,
                  scope: { sessions: ['ses-mine', 'ses-pair'] },
                },
                { agentId: 'a2', name: 'old-client', platform: 'linux', arch: 'x64', connectedAt: 150_000 },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    service.configure(CONN);

    const agents = await service.listRemoteAgents();
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://hub.example.com/hub/api/agents');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer hub-token');
    const [sessionsUrl, sessionsInit] = fetchMock.mock.calls[1]! as [string, RequestInit];
    expect(sessionsUrl).toBe('https://hub.example.com/agents/a1/api/v2/sessions?page_size=100');
    expect(new Headers(sessionsInit.headers).get('authorization')).toBe('Bearer hub-token');
    expect(agents).toEqual([
      {
        agentId: 'a1',
        name: 'dev-box',
        platform: 'darwin',
        arch: 'arm64',
        version: '0.56.1',
        cwd: '/work/kimi-code',
        connectedAt: 170_000,
        sessionIds: ['ses-mine', 'ses-pair'],
        sessionTitles: { 'ses-pair': 'pairing session' },
        legacy: false,
      },
      {
        agentId: 'a2',
        name: 'old-client',
        platform: 'linux',
        arch: 'x64',
        version: undefined,
        cwd: undefined,
        connectedAt: 150_000,
        sessionIds: [],
        sessionTitles: {},
        legacy: true,
      },
    ]);
  });

  it('keeps id-only rows when the session-title lookup fails', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/v2/sessions')) {
        return Promise.reject(new Error('tunnel lost'));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              agents: [
                {
                  agentId: 'a1',
                  name: 'dev-box',
                  platform: 'darwin',
                  arch: 'arm64',
                  connectedAt: 170_000,
                  scope: { sessions: ['ses-mine'] },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    service.configure(CONN);

    const agents = await service.listRemoteAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agentId: 'a1', sessionIds: ['ses-mine'], sessionTitles: {} });
  });

  it('omits the bearer for bypass-mode hubs (empty token)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: 'success', data: { agents: [] } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    service.configure({ ...CONN, token: '' });

    await service.listRemoteAgents();
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('posts a text prompt for the target session and maps the receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { prompt_id: 'p1', user_message_id: 'u1', status: 'queued', content: [], created_at: '2026-08-14T20:00:00Z' },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    service.configure(CONN);

    const receipt = await service.sendToSession({
      agentId: 'agent 42',
      sessionId: 'ses target',
      text: 'hi',
    });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      'https://hub.example.com/agents/agent%2042/api/v1/sessions/ses%20target/prompts',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(receipt).toEqual({
      promptId: 'p1',
      status: 'queued',
      createdAt: '2026-08-14T20:00:00Z',
    });
  });

  it('forwards steer: true in the prompt body when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { prompt_id: 'p2', user_message_id: 'p2', status: 'running', content: [], created_at: '2026-08-14T20:00:00Z' },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    service.configure(CONN);

    await service.sendToSession({ agentId: 'a', sessionId: 's', text: 'ping', steer: true });
    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      content: [{ type: 'text', text: 'ping' }],
      steer: true,
    });
  });

  it('humanizes known hub envelope failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 40302, msg: 'session-scoped agent', data: null }), {
        status: 403,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    service.configure(CONN);

    await expect(
      service.sendToSession({ agentId: 'a', sessionId: 's', text: 'x' }),
    ).rejects.toThrow("the target session is outside its agent's exposed hub scope");
  });

  it('surfaces an unreachable hub without the raw network error only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    service.configure(CONN);

    await expect(service.listRemoteAgents()).rejects.toThrow(
      'cannot reach the hub at https://hub.example.com/: ECONNREFUSED',
    );
  });
});
