/**
 * Tests for the headless slash-command bridge: the catalog shape and the
 * /title + /help semantics against a mocked engine scope (set / show /
 * unknown / missing session). The server + tunnel never start here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHeadlessCommandBridge } from '#/cli/sub/headless/commands';

const metadataMock = vi.hoisted(() => ({
  setTitle: vi.fn(async () => undefined),
  read: vi.fn(async () => ({ title: 'old name' })),
}));
const resumeMock = vi.hoisted(() => vi.fn());

vi.mock('@moonshot-ai/agent-core-v2', () => ({
  ISessionMetadata: Symbol('ISessionMetadata'),
  resumeSessionById: resumeMock,
}));

import { ISessionMetadata } from '@moonshot-ai/agent-core-v2';

function makeCore(): { accessor: { get(token: unknown): unknown } } {
  return {
    accessor: {
      get: () => {
        throw new Error('the bridge must resolve services from the SESSION scope');
      },
    },
  };
}

function makeSession(): { accessor: { get(token: unknown): unknown } } {
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === ISessionMetadata) return metadataMock;
        throw new Error(`unexpected token ${String(token)}`);
      },
    },
  };
}

describe('headless command bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes a small non-interactive catalog', () => {
    const bridge = createHeadlessCommandBridge(Promise.resolve(makeCore() as never));
    expect(bridge.catalog().map((c) => c.name)).toEqual(['title', 'help']);
  });

  it('sets the title through the resumed session scope', async () => {
    resumeMock.mockResolvedValueOnce(makeSession());
    const bridge = createHeadlessCommandBridge(Promise.resolve(makeCore() as never));
    const result = await bridge.execute('session_1', '/title nightly builds');
    expect(resumeMock).toHaveBeenCalledWith(expect.anything(), 'session_1');
    expect(metadataMock.setTitle).toHaveBeenCalledWith('nightly builds');
    expect(result.errors).toEqual([]);
    expect(result.notices[0]).toContain('nightly builds');
  });

  it('shows the current title from session metadata when called bare', async () => {
    resumeMock.mockResolvedValueOnce(makeSession());
    const bridge = createHeadlessCommandBridge(Promise.resolve(makeCore() as never));
    const result = await bridge.execute('session_1', '/title');
    expect(metadataMock.setTitle).not.toHaveBeenCalled();
    expect(result.notices).toEqual(['current title: old name']);
  });

  it('answers /help with the usage list', async () => {
    const bridge = createHeadlessCommandBridge(Promise.resolve(makeCore() as never));
    const result = await bridge.execute('session_1', '/help');
    expect(result.notices[0]).toContain('/title');
    expect(result.notices[0]).toContain('/help');
  });

  it('rejects unknown commands with the available set', async () => {
    const bridge = createHeadlessCommandBridge(Promise.resolve(makeCore() as never));
    const result = await bridge.execute('session_1', '/yolo on');
    expect(result.errors[0]).toContain("unknown command '/yolo'");
    expect(result.errors[0]).toContain('/title');
  });

  it('reports a missing session instead of throwing', async () => {
    resumeMock.mockResolvedValue(undefined);
    const bridge = createHeadlessCommandBridge(Promise.resolve(makeCore() as never));
    const bare = await bridge.execute('session_gone', '/title');
    expect(bare.errors).toEqual(['session session_gone not found']);
    const setting = await bridge.execute('session_gone', '/title x');
    expect(setting.errors).toEqual(['session session_gone not found']);
  });
});
