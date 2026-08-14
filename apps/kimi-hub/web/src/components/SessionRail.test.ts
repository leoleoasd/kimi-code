/**
 * Rail derivation — flat scoped-session entries, the legacy fallback group,
 * and offline rows surviving transient roster gaps. The model is pure; DOM
 * rendering is not covered (this package has no component-test harness).
 */

import { describe, expect, it } from 'vitest';

import type { HubAgentInfo } from '#/hub/api';
import { deriveRailModel, railKey, type RailSessionEntry } from './SessionRail';

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

function shape(entries: readonly RailSessionEntry[]): ReadonlyArray<readonly [string, string, boolean]> {
  return entries.map((e) => [e.agentName, e.sessionId, e.online] as const);
}

describe('deriveRailModel', () => {
  it('flattens scoped agents into one entry per exposed session, in roster order', () => {
    const model = deriveRailModel(
      [
        agent('laptop', { scope: { sessions: ['s1', 's2'] } }),
        agent('server', { scope: { sessions: ['s9'] } }),
      ],
      new Map(),
    );
    expect(shape(model.sessions)).toEqual([
      ['laptop', 's1', true],
      ['laptop', 's2', true],
      ['server', 's9', true],
    ]);
    expect(model.legacy).toEqual([]);
  });

  it('agents without a scope fall back to the legacy group, contributing no entries', () => {
    const oldBox = agent('old-box');
    const model = deriveRailModel(
      [oldBox, agent('scoped', { scope: { sessions: ['s1'] } })],
      new Map(),
    );
    expect(model.legacy).toEqual([oldBox]);
    expect(shape(model.sessions)).toEqual([['scoped', 's1', true]]);
  });

  it('an empty scope contributes no entries', () => {
    const model = deriveRailModel([agent('quiet', { scope: { sessions: [] } })], new Map());
    expect(model.sessions).toEqual([]);
    expect(model.legacy).toEqual([]);
  });

  it('keeps a dropped agent’s scoped entries visible as offline rows', () => {
    const seen = new Map([['laptop', agent('laptop', { scope: { sessions: ['s1', 's2'] } })]]);
    const model = deriveRailModel([], seen);
    expect(shape(model.sessions)).toEqual([
      ['laptop', 's1', false],
      ['laptop', 's2', false],
    ]);
  });

  it('uses the last-seen agent info for offline rows', () => {
    const dropped = agent('laptop', { scope: { sessions: ['s1'] }, connectedAt: 42 });
    const model = deriveRailModel([], new Map([['laptop', dropped]]));
    expect(model.sessions[0]?.agent).toBe(dropped);
  });

  it('the live scope wins on reconnect — stale offline rows drop', () => {
    const seen = new Map([['laptop', agent('laptop', { scope: { sessions: ['s1', 's2'] } })]]);
    const model = deriveRailModel([agent('laptop', { scope: { sessions: ['s2'] } })], seen);
    expect(shape(model.sessions)).toEqual([['laptop', 's2', true]]);
  });

  it('a dropped legacy agent leaves no offline rows', () => {
    const seen = new Map([['old-box', agent('old-box')]]);
    const model = deriveRailModel([], seen);
    expect(model.sessions).toEqual([]);
    expect(model.legacy).toEqual([]);
  });

  it('keys entries by (agent name, session id), never the per-connection agentId', () => {
    const model = deriveRailModel(
      [
        agent('one', { agentId: 'conn-a', scope: { sessions: ['dup'] } }),
        agent('two', { agentId: 'conn-b', scope: { sessions: ['dup'] } }),
      ],
      new Map(),
    );
    const keys = model.sessions.map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => !k.includes('conn-'))).toBe(true);
  });

  it('lists same-name agents with disjoint scopes as separate online entries', () => {
    const connA = agent('laptop', { agentId: 'conn-a', scope: { sessions: ['s1'] } });
    const connB = agent('laptop', { agentId: 'conn-b', scope: { sessions: ['s2'] } });
    const model = deriveRailModel([connA, connB], new Map());
    expect(shape(model.sessions)).toEqual([
      ['laptop', 's1', true],
      ['laptop', 's2', true],
    ]);
    expect(model.sessions[0]?.agent).toBe(connA);
    expect(model.sessions[1]?.agent).toBe(connB);
  });

  it('offline rows keep each dropped same-name connection’s own last-seen agent', () => {
    const connA = agent('laptop', { agentId: 'conn-a', scope: { sessions: ['s1'] } });
    const connB = agent('laptop', { agentId: 'conn-b', scope: { sessions: ['s2'] } });
    const seen = new Map([
      [railKey('laptop', 's1'), connA],
      [railKey('laptop', 's2'), connB],
    ]);
    const model = deriveRailModel([], seen);
    expect(shape(model.sessions)).toEqual([
      ['laptop', 's1', false],
      ['laptop', 's2', false],
    ]);
    expect(model.sessions[0]?.agent).toBe(connA);
    expect(model.sessions[1]?.agent).toBe(connB);
  });

  it('one agent under several (name, session id) keys contributes each row once', () => {
    const dropped = agent('laptop', { scope: { sessions: ['s1', 's2'] } });
    const seen = new Map([
      [railKey('laptop', 's1'), dropped],
      [railKey('laptop', 's2'), dropped],
    ]);
    const model = deriveRailModel([], seen);
    expect(shape(model.sessions)).toEqual([
      ['laptop', 's1', false],
      ['laptop', 's2', false],
    ]);
    expect(model.sessions[0]?.agent).toBe(dropped);
  });
});
