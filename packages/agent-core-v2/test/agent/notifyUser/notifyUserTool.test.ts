/**
 * Scenario: NotifyUser tool publishes `event.user.notify` on the global bus
 * with the session/agent identity of the calling agent.
 * Wiring: the tool class directly with stub services (no harness).
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/notifyUser/`.
 */
import { describe, expect, it } from 'vitest';

import type { IEventService } from '#/app/event/event';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { NotifyUserTool } from '#/agent/tools/notify-user/notifyUserTool';

const signal = new AbortController().signal;

function makeTool(published: { type: string; payload: unknown }[]): NotifyUserTool {
  const events = {
    _serviceBrand: undefined,
    publish: (event: { type: string; payload: unknown }) => {
      published.push(event);
    },
    subscribe: () => ({ dispose: () => undefined }),
  } as unknown as IEventService;
  const session = {
    _serviceBrand: undefined,
    sessionId: 'ses-1',
    workspaceId: 'ws-1',
    sessionDir: '/tmp/ses-1',
    metaScope: 'ses-1',
    cwd: '/tmp',
    scope: () => 'ses-1',
  } as ISessionContext;
  const scopeContext = { _serviceBrand: undefined, agentId: 'main' } as IAgentScopeContext;
  return new NotifyUserTool(events, session, scopeContext);
}

describe('NotifyUserTool', () => {
  it('publishes event.user.notify with the session + agent identity, acking in-band', async () => {
    const published: { type: string; payload: unknown }[] = [];
    const tool = makeTool(published);
    const execution = tool.resolveExecution({ title: 'needs you', body: 'the build failed' });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    const result = await execution.execute({ turnId: 0, toolCallId: 'call-1', signal });
    expect(result.output).toBe('notification sent: needs you');
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe('event.user.notify');
    expect(published[0]?.payload).toMatchObject({
      sessionId: 'ses-1',
      agentId: 'main',
      title: 'needs you',
      body: 'the build failed',
    });
    expect(typeof (published[0]?.payload as { notificationId: string }).notificationId).toBe('string');
  });
});
