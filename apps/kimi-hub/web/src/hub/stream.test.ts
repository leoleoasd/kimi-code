/**
 * `parseRosterFrame` (the envelope-free roster snapshot of the hub's own
 * `WS /hub/api/stream`) and the `RosterStream` socket lifecycle — the engine
 * behind `useRosterStream`. This package has no component-test harness, so
 * the one-effect hook is exercised through the stream directly, with a fake
 * QueryClient + WebSocketImpl — the same split as `TranscriptWs` /
 * `useTranscriptChannel` (see `src/transcript/ws.test.ts`).
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WsLike } from '#/transcript/ws';
import { HUB_AGENTS_QUERY_KEY, type HubAgentInfo } from './api';
import {
  parseRosterFrame,
  parseStreamFrame,
  RosterStream,
  type NotifyPayload,
  type RosterStreamState,
} from './stream';

// ----------------------------------------------------------------- fake ws

type WsEventType = 'open' | 'message' | 'close' | 'error';

class FakeWs implements WsLike {
  static readonly OPEN = 1;
  static instances: FakeWs[] = [];

  readyState = FakeWs.OPEN;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<WsEventType, ((event: unknown) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  addEventListener(type: WsEventType, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(type, list);
  }

  emit(type: WsEventType, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitFrame(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

// ----------------------------------------------------------------- helpers

const ORIGIN = 'http://hub.example.com';

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

function rosterFrame(agents: readonly unknown[]): string {
  return JSON.stringify({ type: 'roster', agents });
}

/** Open a stream over the injected fake and record its lifecycle states. */
function openStream(queryClient: QueryClient, states: RosterStreamState[] = []) {
  const stream = new RosterStream({
    baseUrl: ORIGIN,
    token: 'tok-1',
    queryClient,
    WebSocketImpl: FakeWs,
    onStateChange: (state) => states.push(state),
    onNotify: (notify) => notifyLog.push(notify),
  });
  return { stream, socket: FakeWs.instances.at(-1)! };
}

/** Recorded `onNotify` deliveries for the open stream. */
const notifyLog: NotifyPayload[] = [];

// ------------------------------------------------------------- parse frame

describe('parseRosterFrame', () => {
  it('parses a full roster snapshot', () => {
    const a = agent('laptop', { version: '0.1.0', cwd: '/work', pid: 4242, scope: { sessions: ['s1'] } });
    expect(parseRosterFrame(rosterFrame([a]))).toEqual([a]);
  });

  it('drops malformed entries but keeps the valid ones', () => {
    const good = agent('laptop');
    expect(parseRosterFrame(rosterFrame([good, { name: 1 }, null, 'x']))).toEqual([good]);
  });

  it('returns undefined when `agents` is missing or not an array', () => {
    expect(parseRosterFrame(JSON.stringify({ type: 'roster' }))).toBeUndefined();
    expect(parseRosterFrame(JSON.stringify({ type: 'roster', agents: null }))).toBeUndefined();
    expect(parseRosterFrame(JSON.stringify({ type: 'roster', agents: 'nope' }))).toBeUndefined();
  });

  it('returns undefined for other frame types and for the REST envelope', () => {
    expect(parseRosterFrame(JSON.stringify({ type: 'ping', payload: {} }))).toBeUndefined();
    // The REST route's envelope is NOT what the stream sends:
    expect(
      parseRosterFrame(JSON.stringify({ code: 0, msg: 'ok', data: { agents: [] } })),
    ).toBeUndefined();
  });

  it('returns undefined for non-JSON and non-object payloads', () => {
    expect(parseRosterFrame('not json')).toBeUndefined();
    expect(parseRosterFrame(JSON.stringify('roster'))).toBeUndefined();
    expect(parseRosterFrame(JSON.stringify([{ type: 'roster', agents: [] }]))).toBeUndefined();
  });
});

describe('parseStreamFrame (the notify branch)', () => {
  it('parses a notify frame into the payload', () => {
    expect(
      parseStreamFrame(
        JSON.stringify({
          type: 'notify',
          notificationId: 'ntf-1',
          sessionId: 'ses-1',
          agentId: 'agent-1',
          agentName: 'laptop',
          title: 'needs you',
          body: 'the build failed',
        }),
      ),
    ).toEqual({
      type: 'notify',
      notify: {
        notificationId: 'ntf-1',
        sessionId: 'ses-1',
        agentId: 'agent-1',
        agentName: 'laptop',
        title: 'needs you',
        body: 'the build failed',
      },
    });
  });

  it('returns undefined when a notify field is missing', () => {
    expect(
      parseStreamFrame(JSON.stringify({ type: 'notify', notificationId: 'x', title: 't' })),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------- stream ws

describe('RosterStream → notify callback', () => {
  it('routes a notify frame to onNotify and skips the roster cache write', () => {
    const queryClient = new QueryClient();
    const { socket } = openStream(queryClient);
    socket.emitFrame({
      type: 'notify',
      notificationId: 'n1',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'laptop',
      title: 't',
      body: 'b',
    });
    expect(notifyLog.at(-1)).toEqual({
      notificationId: 'n1',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'laptop',
      title: 't',
      body: 'b',
    });
    expect(queryClient.getQueryData(HUB_AGENTS_QUERY_KEY)).toBeUndefined();
  });
});

// ------------------------------------------------------------- stream ws

describe('RosterStream', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    notifyLog.length = 0;
    FakeWs.instances = [];
    queryClient = new QueryClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    queryClient.clear();
  });

  it('opens {hubOrigin}/hub/api/stream with the bearer subprotocol', () => {
    const { stream, socket } = openStream(queryClient);
    expect(socket.url).toBe('ws://hub.example.com/hub/api/stream');
    expect(socket.protocols).toEqual(['kimi-hub.bearer.tok-1']);
    stream.close();
  });

  it('omits the subprotocol entirely for the empty (authless) token', () => {
    const stream = new RosterStream({
      baseUrl: ORIGIN,
      token: '',
      queryClient,
      WebSocketImpl: FakeWs,
    });
    expect(FakeWs.instances.at(-1)!.protocols).toBeUndefined();
    stream.close();
  });

  it('writes roster frames into the shared hub-agents cache and reports state', () => {
    const states: RosterStreamState[] = [];
    const { stream, socket } = openStream(queryClient, states);
    expect(queryClient.getQueryData(HUB_AGENTS_QUERY_KEY)).toBeUndefined();

    socket.emit('open');
    expect(states).toEqual([{ online: true, rosterAge: 0 }]);

    const first = [agent('laptop')];
    socket.emit('message', { data: rosterFrame(first) });
    expect(queryClient.getQueryData(HUB_AGENTS_QUERY_KEY)).toEqual(first);
    expect(states.at(-1)).toEqual({ online: true, rosterAge: 0 });

    // A later snapshot replaces the cached roster (the stream is an overlay).
    const next = [agent('laptop'), agent('server', { scope: { sessions: ['s1'] } })];
    socket.emit('message', { data: rosterFrame(next) });
    expect(queryClient.getQueryData(HUB_AGENTS_QUERY_KEY)).toEqual(next);
    stream.close();
  });

  it('ignores frames that are not roster snapshots', () => {
    const { stream, socket } = openStream(queryClient);
    socket.emit('open');
    socket.emitFrame({ type: 'ping', payload: {} });
    socket.emit('message', { data: 'not json' });
    socket.emit('message', { data: JSON.stringify({ type: 'roster', agents: 'nope' }) });
    expect(queryClient.getQueryData(HUB_AGENTS_QUERY_KEY)).toBeUndefined();
    stream.close();
  });

  it('reconnects with exponential backoff while mounted', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // jitter floor ×0.8 → delays 400, 800, 1600…
    const states: RosterStreamState[] = [];
    const { stream } = openStream(queryClient, states);

    FakeWs.instances[0]!.emit('open');
    FakeWs.instances[0]!.emit('close');
    expect(states.at(-1)).toEqual({ online: false, rosterAge: 0 });

    vi.advanceTimersByTime(399);
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(2);

    // No 'open' this time → the attempt counter keeps growing: 800ms delay.
    FakeWs.instances[1]!.emit('close');
    vi.advanceTimersByTime(799);
    expect(FakeWs.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWs.instances).toHaveLength(3);
    stream.close();
  });

  it('never reconnects after close (unmount) — an open socket first', () => {
    const { stream, socket } = openStream(queryClient);
    socket.emit('open');
    stream.close();
    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it('never reconnects after close (unmount) — a backoff timer was pending', () => {
    const { stream, socket } = openStream(queryClient);
    socket.emit('open');
    socket.emit('close'); // schedules the 500ms-class reconnect
    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.instances).toHaveLength(1);
  });
});
