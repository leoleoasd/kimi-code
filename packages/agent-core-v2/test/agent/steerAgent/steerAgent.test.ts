import { describe, expect, it } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService, type SteerPayload } from '#/agent/prompt/prompt';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  type AgentMeta,
  ISessionMetadata,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { SteerAgentTool } from '#/agent/tools/steer-agent/steerAgentTool';
import type { ToolExecution } from '#/tool/toolContract';

const signal = new AbortController().signal;

interface TargetOptions {
  readonly state?: 'idle' | 'running';
  readonly steerResult?: { readonly turn_id: number } | undefined;
  readonly steerError?: Error;
  readonly calls?: SteerPayload[];
}

function stubTarget(opts: TargetOptions): IAgentScopeHandle {
  const loop = {
    status: () => ({ state: opts.state ?? 'running' }),
  } as unknown as IAgentLoopService;
  const prompt = {
    submitSteer: async (payload: SteerPayload) => {
      opts.calls?.push(payload);
      if (opts.steerError !== undefined) throw opts.steerError;
      return opts.steerResult;
    },
  } as unknown as IAgentPromptService;
  return {
    id: 'agent-sub1',
    accessor: {
      get: (token: unknown) =>
        token === IAgentLoopService ? loop : token === IAgentPromptService ? prompt : undefined,
    },
  } as unknown as IAgentScopeHandle;
}

function stubLifecycle(target: IAgentScopeHandle | undefined): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    get: (agentId: string) => (target !== undefined && agentId === target.id ? target : undefined),
  } as unknown as IAgentLifecycleService;
}

function stubMetadata(agents: Record<string, AgentMeta>): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    read: async () => ({ agents }) as unknown as SessionMeta,
  } as unknown as ISessionMetadata;
}

const CALLER = { _serviceBrand: undefined, agentId: 'main' } as IAgentScopeContext;

function stubProfile(profileName: string | undefined): IAgentProfileService {
  return {
    _serviceBrand: undefined,
    data: () => ({ profileName }) as never,
  } as unknown as IAgentProfileService;
}

const OWNED_META = { labels: { parentAgentId: 'main' } } as AgentMeta;
const FOREIGN_META = { labels: { parentAgentId: 'agent-other' } } as AgentMeta;

function makeTool(
  target: IAgentScopeHandle | undefined,
  meta: Record<string, AgentMeta>,
  profileName: string | undefined = 'main',
): SteerAgentTool {
  return new SteerAgentTool(stubLifecycle(target), stubMetadata(meta), CALLER, stubProfile(profileName));
}

async function run(
  execution: ToolExecution,
): Promise<{ output: string | unknown[]; isError: boolean }> {
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  const result = await execution.execute({ turnId: 0, toolCallId: 'call-1', signal });
  return { output: result.output as unknown[] | string, isError: result.isError === true };
}

describe('SteerAgentTool', () => {
  it('steers into a running subagent with an orchestrator envelope', async () => {
    const calls: SteerPayload[] = [];
    const target = stubTarget({ calls, steerResult: { turn_id: 7 } });
    const result = await run(
      makeTool(target, { 'agent-sub1': OWNED_META }).resolveExecution({
        agent_id: 'agent-sub1',
        message: 'skip the lint pass, go straight to the failing test',
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("steered into agent-sub1's turn (turn_id 7)");
    expect(calls).toHaveLength(1);
    const text = calls[0]!.input[0];
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') throw new Error('expected a text part');
    expect(text.text).toContain('[steered message from your orchestrating agent ("main", agent_id main)]');
    expect(text.text).toContain('does NOT replace your original task');
    expect(text.text).toContain('skip the lint pass, go straight to the failing test');
  });

  it('a stopped subagent is refused with a pointer to Agent(resume=…)', async () => {
    const calls: SteerPayload[] = [];
    const target = stubTarget({ calls, state: 'idle' });
    const result = await run(
      makeTool(target, { 'agent-sub1': OWNED_META }).resolveExecution({
        agent_id: 'agent-sub1',
        message: 'hello?',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not running');
    expect(result.output).toContain('Agent(resume="agent-sub1"');
    expect(calls).toHaveLength(0);
  });

  it('an unknown agent id is refused with the agent_id-not-task_id hint', async () => {
    const result = await run(
      makeTool(undefined, {}).resolveExecution({ agent_id: 'agent-nope', message: 'x' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    expect(result.output).toContain('NOT the task_id');
  });

  it('a non-subagent target points at SendHubMessage', async () => {
    const target = stubTarget({});
    const result = await run(
      makeTool(target, {}).resolveExecution({ agent_id: 'agent-sub1', message: 'x' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not your subagent');
    expect(result.output).toContain('SendHubMessage');
  });

  it('a subagent owned by another parent is refused', async () => {
    const calls: SteerPayload[] = [];
    const target = stubTarget({ calls });
    const result = await run(
      makeTool(target, { 'agent-sub1': FOREIGN_META }).resolveExecution({
        agent_id: 'agent-sub1',
        message: 'x',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('different parent');
    expect(calls).toHaveLength(0);
  });

  it('a mid-steer race (turn ended) reports the queued next turn without an error', async () => {
    const target = stubTarget({ steerResult: undefined });
    const result = await run(
      makeTool(target, { 'agent-sub1': OWNED_META }).resolveExecution({
        agent_id: 'agent-sub1',
        message: 'x',
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain('launches as its next turn');
  });

  it('a steer injection failure surfaces as an error result', async () => {
    const target = stubTarget({ steerError: new Error('loop disposed') });
    const result = await run(
      makeTool(target, { 'agent-sub1': OWNED_META }).resolveExecution({
        agent_id: 'agent-sub1',
        message: 'x',
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('loop disposed');
  });
});
