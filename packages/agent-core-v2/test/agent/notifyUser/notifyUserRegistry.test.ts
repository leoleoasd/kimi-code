import { afterEach, describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import '#/session/agentLifecycle/profile/profiles';

import { createTestAgent, type TestAgentContext } from '../../harness';

const NAMES = ['NotifyUser', 'ListHubSessions', 'SendHubMessage'] as const;

describe.each(NAMES)('%s registration', (toolName) => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('is on the builtin contribution table', () => {
    const names = getAgentToolContributions().map((c) => c.options.name);
    expect(names).toContain(toolName);
  });

  it('is allowed by every builtin profile tool allowlist', () => {
    const profiles = getAgentProfileContributions().filter((p) => p.tools !== undefined);
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(profile.tools, `profile ${profile.name}`).toContain(toolName);
    }
  });

  it('is active in an assembled agent runtime registry', () => {
    ctx = createTestAgent();
    expect(ctx.get(IAgentToolRegistryService).resolve(toolName)).toBeDefined();
  });
});
