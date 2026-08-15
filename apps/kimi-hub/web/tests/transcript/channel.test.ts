/**
 * Channel streaming grade: the chat pane subscribes at 'delta' so per-token
 * `append` chunks flow through to the store. This file pins (a) the subscribe
 * frame's grade and (b) the end-to-end accumulation: `transcript.ops` batches
 * arriving like the server emits them mid-token must leave the store holding
 * the FULL cumulative text (the render layer re-paints `frame.text` as-is).
 *
 * The hook itself is not mountable headlessly (no component-test harness in
 * this package); its live apply path is exactly `store.applyOps(ops)`, which
 * is what the fake socket feeds here.
 */

import type {
  TranscriptFrame,
  TranscriptItem,
} from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import { TranscriptChatStore } from '#/transcript/store';
import { CHANNEL_TRANSCRIPT_GRADE } from '#/transcript/channel';
import { TranscriptWs, type WsLike } from '#/transcript/ws';

// ----------------------------------------------------------------- fake ws

type WsEventType = 'open' | 'message' | 'close' | 'error';

class FakeWs implements WsLike {
  static readonly OPEN = 1;
  static instances: FakeWs[] = [];

  readyState = FakeWs.OPEN;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<WsEventType, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
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

function openWs(extra?: Record<string, unknown>) {
  const channel = new TranscriptWs({
    url: BASE,
    sessionId: 's1',
    agentId: 'main',
    WebSocketImpl: FakeWs,
    handlers: { onOps: () => {}, onResyncRequired: () => {}, onReconnected: () => {} },
    ...extra,
  });
  const socket = FakeWs.instances.pop()!;
  socket.emit('open');
  return { channel, socket };
}

function sentFrames(socket: FakeWs): { type: string; payload?: Record<string, unknown> }[] {
  return socket.sent.map(
    (raw) => JSON.parse(raw) as { type: string; payload?: Record<string, unknown> },
  );
}

describe('channel streaming grade', () => {
  it('subscribes at delta (the constant the hook passes)', () => {
    expect(CHANNEL_TRANSCRIPT_GRADE).toBe('delta');
    const { channel, socket } = openWs({ grade: CHANNEL_TRANSCRIPT_GRADE });
    const subscribe = sentFrames(socket).find((f) => f.type === 'subscribe_v2');
    expect(subscribe?.payload?.['transcript']).toEqual({ main: 'delta' });
    channel.close();
  });

  it('the TranscriptWs default grade stays block (legacy behavior)', () => {
    const { channel, socket } = openWs();
    const subscribe = sentFrames(socket).find((f) => f.type === 'subscribe_v2');
    expect(subscribe?.payload?.['transcript']).toEqual({ main: 'block' });
    channel.close();
  });

  it('growing transcript.ops batches accumulate the FULL frame text in the store', () => {
    // Mirrors the channel's live path: ops for our agent go straight into the
    // store (buffering aside — covered by the store/convergence semantics).
    const store = new TranscriptChatStore();
    const channel = new TranscriptWs({
      url: BASE,
      sessionId: 's1',
      agentId: 'main',
      grade: CHANNEL_TRANSCRIPT_GRADE,
      WebSocketImpl: FakeWs,
      handlers: {
        onOps: (agentId, ops) => {
          if (agentId === 'main') store.applyOps(ops);
        },
        onResyncRequired: () => {},
        onReconnected: () => {},
      },
    });
    const socket = FakeWs.instances.pop()!;
    socket.emit('open');

    // Batch 1: the frame lands with its first token. (Server payloads carry
    // their own `type` — see buildTranscriptEnvelope in kap-server.)
    socket.emitFrame({
      type: 'transcript.ops',
      payload: {
        type: 'transcript.ops',
        agent_id: 'main',
        seq: 1,
        ops: [
          {
            op: 'turn.upsert',
            turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' } },
          },
          {
            op: 'step.upsert',
            turnId: 't1',
            step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
          },
          {
            op: 'frame.upsert',
            turnId: 't1',
            stepId: 't1.1',
            frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'Hell' },
          },
        ],
      },
    });
    // Batches 2..N: per-token appends exactly as a delta stream emits them.
    socket.emitFrame({
      type: 'transcript.ops',
      payload: {
        type: 'transcript.ops',
        agent_id: 'main',
        seq: 2,
        ops: [
          { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 4, text: 'o, w' },
        ],
      },
    });
    socket.emitFrame({
      type: 'transcript.ops',
      payload: {
        type: 'transcript.ops',
        agent_id: 'main',
        seq: 3,
        ops: [
          { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 8, text: 'orld!' },
        ],
      },
    });

    const turn = store.getState().items[0] as Extract<TranscriptItem, { kind: 'turn' }>;
    expect(turn.kind).toBe('turn');
    const frame = turn.steps[0]?.frames[0] as Extract<TranscriptFrame, { kind: 'text' }>;
    expect(frame.kind).toBe('text');
    expect(frame.text).toBe('Hello, world!');
    channel.close();
  });

  it('the transcript_since watermark rides the resubscribe after reconnect', () => {
    let since: number | undefined;
    const channel = new TranscriptWs({
      url: BASE,
      sessionId: 's1',
      agentId: 'main',
      grade: CHANNEL_TRANSCRIPT_GRADE,
      WebSocketImpl: FakeWs,
      getSince: () => since,
      handlers: { onOps: () => {}, onResyncRequired: () => {}, onReconnected: () => {} },
    });
    const first = FakeWs.instances.pop()!;
    first.emit('open');
    // No watermark yet: no transcript_since key on the first subscribe.
    expect(sentFrames(first).find((f) => f.type === 'subscribe_v2')?.payload?.['transcript_since']).toBeUndefined();
    channel.close();
    // A (re)connect with a known watermark resumes with transcript_since.
    since = 41;
    const second = new TranscriptWs({
      url: BASE,
      sessionId: 's1',
      agentId: 'main',
      grade: CHANNEL_TRANSCRIPT_GRADE,
      WebSocketImpl: FakeWs,
      getSince: () => since,
      handlers: { onOps: () => {}, onResyncRequired: () => {}, onReconnected: () => {} },
    });
    const reopened = FakeWs.instances.pop()!;
    reopened.emit('open');
    const subscribe = sentFrames(reopened).find((f) => f.type === 'subscribe_v2');
    expect(subscribe?.payload?.['transcript_since']).toEqual({ main: 41 });
    second.close();
  });
});
