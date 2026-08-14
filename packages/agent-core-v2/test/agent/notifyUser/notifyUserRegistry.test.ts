/**
 * Scenario: NotifyUser is on the builtin contribution table, allowed by every
 * builtin profile's tool allowlist (the production activation gate), AND
 * active in a real assembled agent's runtime registry.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/notifyUser/`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import '#/session/agentLifecycle/profile/profiles';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('NotifyUser registration', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('is on the builtin contribution table', () => {
    const names = getAgentToolContributions().map((c) => c.options.name);
    expect(names).toContain('NotifyUser');
  });

  it('is allowed by every builtin profile tool allowlist', () => {
    const profiles = getAgentProfileContributions().filter((p) => p.tools !== undefined);
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      expect(profile.tools, `profile ${profile.name}`).toContain('NotifyUser');
    }
  });

  it('is active in an assembled agent runtime registry', () => {
    ctx = createTestAgent();
    expect(ctx.get(IAgentToolRegistryService).resolve('NotifyUser')).toBeDefined();
  });
});
