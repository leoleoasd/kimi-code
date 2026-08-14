/**
 * `TranscriptWs` frame dispatch for the global `session.meta.updated`
 * broadcast — rename / auto-title frames travel to every connection with no
 * subscription; the client only extracts and forwards (session id, title).
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { sessionInfoQueryKey } from '#/sessions/api';
import { TranscriptWs, type SessionMetaUpdated, type WsLike } from './ws';

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

const BASE = 'http://hub.example.com/agents/agent-1';

/** Open a channel over the injected fake and hand back both ends. */
function openChannel(
  onSessionMetaUpdated: (meta: SessionMetaUpdated) => void,
  extra?: { token?: string },
) {
  const channel = new TranscriptWs({
    url: BASE,
    sessionId: 's1',
    agentId: 'main',
    WebSocketImpl: FakeWs,
    token: extra?.token,
    handlers: {
      onOps: () => {},
      onResyncRequired: () => {},
      onReconnected: () => {},
      onSessionMetaUpdated,
    },
  });
  const socket = FakeWs.instances.pop()!;
  return { channel, socket };
}

function metaFrame(sessionId: string, extra?: { title?: unknown; noEnvelopeSessionId?: boolean }) {
  return {
    type: 'session.meta.updated',
    seq: 9,
    timestamp: '2026-08-13T00:00:00.000Z',
    ...(extra?.noEnvelopeSessionId === true ? {} : { session_id: sessionId }),
    payload: {
      type: 'session.meta.updated',
      sessionId,
      agentId: 'main',
      ...(extra && 'title' in extra ? { title: extra.title } : { title: 'a new title' }),
    },
  };
}

describe('TranscriptWs session.meta.updated', () => {
  it('fires the handler with the envelope session id and the payload title', () => {
    const seen: SessionMetaUpdated[] = [];
    const { channel, socket } = openChannel((meta) => seen.push(meta));
    socket.emitFrame(metaFrame('s1', { title: 'renamed from the TUI' }));
    expect(seen).toEqual([{ sessionId: 's1', title: 'renamed from the TUI' }]);
    channel.close();
  });

  it('frames without a usable session id are dropped', () => {
    const seen: SessionMetaUpdated[] = [];
    const { channel, socket } = openChannel((meta) => seen.push(meta));
    socket.emitFrame({ type: 'session.meta.updated', payload: { title: 'no routing' } });
    socket.emitFrame({ type: 'transcript.reset', payload: {} });
    expect(seen).toEqual([]);
    channel.close();
  });

  it('falls back to the camelCase payload id, and title may be absent', () => {
    const seen: SessionMetaUpdated[] = [];
    const { channel, socket } = openChannel((meta) => seen.push(meta));
    socket.emitFrame(metaFrame('s2', { noEnvelopeSessionId: true, title: undefined }));
    expect(seen).toEqual([{ sessionId: 's2', title: undefined }]);
    channel.close();
  });

  it('the handler can drive a realtime title refresh through a headless QueryClient', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionInfoQueryKey(BASE, 's1'), {
      id: 's1',
      title: 'old title',
      lastPrompt: null,
    });
    let invalidation = Promise.resolve();
    // Mirrors App's onSessionMetaUpdated: invalidate the shared session-info
    // key; mounted observers (chat header, rail rows) refetch it.
    const { channel, socket } = openChannel((meta) => {
      invalidation = queryClient
        .invalidateQueries({ queryKey: sessionInfoQueryKey(BASE, meta.sessionId) })
        .then(() => undefined);
    });
    expect(queryClient.getQueryState(sessionInfoQueryKey(BASE, 's1'))?.isInvalidated).toBe(false);
    socket.emitFrame(metaFrame('s1', { title: 'flipped live' }));
    await invalidation;
    expect(queryClient.getQueryState(sessionInfoQueryKey(BASE, 's1'))?.isInvalidated).toBe(true);
    channel.close();
    queryClient.clear();
  });
});

describe('TranscriptWs auth subprotocol', () => {
  it('offers the kimi-hub.bearer subprotocol for a real token', () => {
    const { channel, socket } = openChannel(() => {}, { token: 'tok-9' });
    expect(socket.protocols).toEqual(['kimi-hub.bearer.tok-9']);
    channel.close();
  });

  it('omits the subprotocol entirely for the empty (authless) token', () => {
    const { channel, socket } = openChannel(() => {}, { token: '' });
    expect(socket.protocols).toBeUndefined();
    channel.close();
  });
});
