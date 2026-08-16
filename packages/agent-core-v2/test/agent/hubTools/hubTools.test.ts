/**
 * Scenario: the hub-gated tools — ListHubSessions renders the roster for the
 * model; SendHubMessage locates the target session's owner agent, wraps the
 * message in a provenance header, and delivers it through the hub. Both error
 * cleanly when the process is not connected to a hub.
 * Wiring: the tool classes directly with stub services (same pattern as the
 * NotifyUser tool test — no harness).
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/hubTools/`.
 */
import { describe, expect, it } from 'vitest';

import type { HubConnection, HubRemoteAgent, IHubConnectionService } from '#/hub/hubConnection';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { formatRoster, ListHubSessionsTool } from '#/agent/tools/list-hub-sessions/listHubSessionsTool';
import { SendHubMessageTool } from '#/agent/tools/send-hub-message/sendHubMessageTool';
import type { ToolExecution } from '#/tool/toolContract';

const signal = new AbortController().signal;

const CONNECTION: HubConnection = {
  hubUrl: 'https://hub.example.com',
  token: 'hub-token',
  agentName: 'dev-box',
  sessionIds: ['ses-mine', 'ses-pair'],
};

const ROSTER: HubRemoteAgent[] = [
  {
    agentId: 'a1',
    name: 'dev-box',
    platform: 'darwin',
    arch: 'arm64',
    version: '0.56.1',
    cwd: '/work/kimi-code',
    connectedAt: 170_000,
    sessionIds: ['ses-mine', 'ses-pair'],
    sessionTitles: { 'ses-pair': 'pair designing' },
    legacy: false,
  },
  {
    agentId: 'a2',
    name: 'ci-worker',
    platform: 'linux',
    arch: 'x64',
    connectedAt: 150_000,
    sessionIds: ['ses-ci'],
    sessionTitles: {},
    legacy: false,
  },
  {
    agentId: 'a3',
    name: 'old-client',
    platform: 'linux',
    arch: 'x64',
    connectedAt: 120_000,
    sessionIds: [],
    sessionTitles: {},
    legacy: true,
  },
];

interface HubStubOptions {
  agents?: HubRemoteAgent[];
  listError?: Error;
  sendError?: Error;
  connection?: HubConnection | undefined;
}

function stubHub(opts: HubStubOptions, sent: { agentId: string; sessionId: string; text: string; steer?: boolean }[]): IHubConnectionService {
  return {
    _serviceBrand: undefined,
    configure: () => undefined,
    connection: () => ('connection' in opts ? opts.connection : CONNECTION),
    listRemoteAgents: async () => {
      if (opts.listError !== undefined) throw opts.listError;
      return opts.agents ?? ROSTER;
    },
    sendToSession: async (target) => {
      if (opts.sendError !== undefined) throw opts.sendError;
      sent.push(target);
      return { promptId: 'p1', status: 'queued', createdAt: '2026-08-14T20:00:00Z' };
    },
  };
}

function stubSession(sessionId: string): ISessionContext {
  return { _serviceBrand: undefined, sessionId } as ISessionContext;
}

async function run(execution: ToolExecution): Promise<{ output: string | unknown[]; isError?: boolean }> {
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  const result = await execution.execute({ turnId: 0, toolCallId: 'call-1', signal });
  return { output: result.output as unknown[] | string, isError: 'isError' in result && result.isError === true };
}

describe('ListHubSessionsTool', () => {
  it('errors with the connect hint when the process is not attached to a hub', async () => {
    const tool = new ListHubSessionsTool(stubHub({ connection: undefined }, []));
    const result = await run(tool.resolveExecution({}));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not connected to a kimi hub');
  });

  it('renders the roster with per-agent sessions, flagging this process’s own bridges', async () => {
    const tool = new ListHubSessionsTool(stubHub({}, []));
    const result = await run(tool.resolveExecution({}));
    expect(result.isError).toBe(false);
    const output = String(result.output);
    expect(output).toContain('"dev-box" (a1)');
    expect(output).toContain('ses-mine  (bridged from this machine)');
    expect(output).toContain('"pair designing" (ses-pair)');
    expect(output).toContain('"ci-worker" (a2)');
    expect(output).toContain('- ses-ci\n');
    expect(output).toContain('legacy connection');
    expect(output).toContain('SendHubMessage');
  });

  it('reports an empty hub', () => {
    const rendered = formatRoster([], CONNECTION);
    expect(rendered).toContain('no agents are currently connected');
  });

  it('forwards a hub-query failure as an error result', async () => {
    const tool = new ListHubSessionsTool(
      stubHub({ listError: new Error('hub answered HTTP 500 with a non-JSON body') }, []),
    );
    const result = await run(tool.resolveExecution({}));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('hub answered HTTP 500');
  });
});

describe('SendHubMessageTool', () => {
  it('errors with the connect hint when the process is not attached to a hub', async () => {
    const tool = new SendHubMessageTool(
      stubHub({ connection: undefined }, []),
      stubSession('ses-mine'),
    );
    const result = await run(tool.resolveExecution({ session_id: 'ses-ci', message: 'hi' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not connected to a kimi hub');
  });

  it('refuses to message its own session', async () => {
    const sent: { agentId: string; sessionId: string; text: string }[] = [];
    const tool = new SendHubMessageTool(stubHub({}, sent), stubSession('ses-mine'));
    const result = await run(tool.resolveExecution({ session_id: 'ses-mine', message: 'hi' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain('your own session');
    expect(sent).toHaveLength(0);
  });

  it('targets the owning agent, steers into its turn, and wraps the sender identity + continuation', async () => {
    const sent: { agentId: string; sessionId: string; text: string; steer?: boolean }[] = [];
    const tool = new SendHubMessageTool(stubHub({}, sent), stubSession('ses-mine'));
    const result = await run(tool.resolveExecution({ session_id: 'ses-ci', message: 'I changed X' }));
    expect(result.isError).toBe(false);
    expect(String(result.output)).toContain('queued');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe('a2');
    expect(sent[0]!.sessionId).toBe('ses-ci');
    // Mid-turn delivery rides the server's steer mode, never the prompt FIFO.
    expect(sent[0]!.steer).toBe(true);
    expect(sent[0]!.text).toContain('[kimi-hub message from dev-box (session ses-mine)]');
    expect(sent[0]!.text).toContain('continue with whatever you were working on');
    expect(sent[0]!.text).toContain('I changed X');
    expect(sent[0]!.text.endsWith('I changed X')).toBe(true);
  });

  it('errors when no agent exposes the target session', async () => {
    const sent: { agentId: string; sessionId: string; text: string }[] = [];
    const tool = new SendHubMessageTool(stubHub({}, sent), stubSession('ses-mine'));
    const result = await run(tool.resolveExecution({ session_id: 'ses-nope', message: 'hi' }));
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('ses-nope is not exposed on the hub');
    expect(sent).toHaveLength(0);
  });

  it('forwards a delivery failure as an error result', async () => {
    const tool = new SendHubMessageTool(
      stubHub({ sendError: new Error('the hub timed out waiting for the target agent machine') }, []),
      stubSession('ses-mine'),
    );
    const result = await run(tool.resolveExecution({ session_id: 'ses-ci', message: 'hi' }));
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('timed out');
  });
});
