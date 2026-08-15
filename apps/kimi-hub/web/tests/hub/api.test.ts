/**
 * `resolveSelectedAgent` — re-resolving the (agent name, session id)
 * selection against the live roster. Two connections from the same host
 * share the name but are scoped to DISJOINT sessions; name-only resolution
 * would rebind an open chat to an agent that refuses the session (`40302`),
 * so the session half of the selection is part of the match, and a failed
 * match reads as OFFLINE (`null`) rather than a wrong-agent fallback.
 */

import { describe, expect, it } from 'vitest';

import { resolveSelectedAgent, type HubAgentInfo } from '#/hub/api';

function agent(name: string, extra?: Partial<HubAgentInfo>): HubAgentInfo {
  return {
    agentId: `agentid-${name}`,
    name,
    platform: 'linux',
    arch: 'x64',
    connectedAt: 1_000,
    ...extra,
  };
}

describe('resolveSelectedAgent', () => {
  it('resolves nothing without a selection or a roster', () => {
    expect(resolveSelectedAgent(undefined, 'laptop', 's1')).toBeNull();
    expect(resolveSelectedAgent([agent('laptop')], null, null)).toBeNull();
    expect(resolveSelectedAgent([], 'laptop', null)).toBeNull();
  });

  it('resolves the first same-name entry when no session is selected', () => {
    const a = agent('laptop', { agentId: 'conn-a', scope: { sessions: ['s1'] } });
    const b = agent('laptop', { agentId: 'conn-b', scope: { sessions: ['s2'] } });
    expect(resolveSelectedAgent([a, b], 'laptop', null)).toBe(a);
    expect(resolveSelectedAgent([b, a], 'laptop', null)).toBe(b);
  });

  it('picks the same-name entry whose scope exposes the selected session', () => {
    const a = agent('laptop', { agentId: 'conn-a', scope: { sessions: ['s1'] } });
    const b = agent('laptop', { agentId: 'conn-b', scope: { sessions: ['s2'] } });
    expect(resolveSelectedAgent([a, b], 'laptop', 's2')).toBe(b);
    expect(resolveSelectedAgent([a, b], 'laptop', 's1')).toBe(a);
  });

  it('returns null when no live entry exposes the session — the same name is not enough', () => {
    const a = agent('laptop', { agentId: 'conn-a', scope: { sessions: ['s1'] } });
    // …even while another same-name connection (here the only one) is live.
    expect(resolveSelectedAgent([a], 'laptop', 's2')).toBeNull();
  });

  it('an unscoped (legacy) entry matches any session id', () => {
    const legacy = agent('old-box');
    expect(resolveSelectedAgent([legacy], 'old-box', 'any-session')).toBe(legacy);
  });

  it('a scoped owner wins over a same-name unscoped entry, whatever the roster order', () => {
    const legacy = agent('laptop', { agentId: 'conn-legacy' });
    const scoped = agent('laptop', { agentId: 'conn-scoped', scope: { sessions: ['s1'] } });
    expect(resolveSelectedAgent([legacy, scoped], 'laptop', 's1')).toBe(scoped);
    expect(resolveSelectedAgent([scoped, legacy], 'laptop', 's1')).toBe(scoped);
    // …and a session no scoped entry exposes still lands on the legacy one.
    expect(resolveSelectedAgent([legacy, scoped], 'laptop', 's9')).toBe(legacy);
  });
});
