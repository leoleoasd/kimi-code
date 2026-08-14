import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        isCompacting: false,
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
        engineQueuedPrompts: [],
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      completeToolResult: vi.fn(),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as any };
}

function turnStarted(prompt: string | undefined, origin: unknown = { kind: 'user' }) {
  return { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin, prompt } as any;
}

describe('SessionEventHandler turn.begin — user prompts from other surfaces', () => {
  it('appends a user bubble for a prompt NOT submitted by this TUI (hub / remote control)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(turnStarted('hello from the hub'), vi.fn());
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', content: 'hello from the hub' }),
    );
  });

  it('skips the bubble for its own already-echoed prompt', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.recordLocalPromptText('local hello');
    handler.handleEvent(turnStarted('local hello'), vi.fn());
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('consumes one record per identical prompt — the same text from another surface still shows once', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.recordLocalPromptText('same text');
    handler.handleEvent(turnStarted('same text'), vi.fn());
    handler.handleEvent(turnStarted('same text'), vi.fn());
    expect(host.appendTranscriptEntry).toHaveBeenCalledTimes(1);
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', content: 'same text' }),
    );
  });

  it('does not bubble non-user origins or turns carrying no prompt text', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(
      turnStarted('ping', {
        kind: 'cron_job',
        jobId: 'j1',
        cron: '*',
        recurring: false,
        coalescedCount: 1,
        stale: false,
      }),
      vi.fn(),
    );
    handler.handleEvent(turnStarted(undefined), vi.fn());
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
  });

  it('clears the echo records on resetRuntimeState (session switch)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.recordLocalPromptText('leftover');
    handler.resetRuntimeState();
    handler.handleEvent(turnStarted('leftover'), vi.fn());
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', content: 'leftover' }),
    );
  });

  it('marks media the engine strips from turn.started.prompt for a hub-sent prompt (FIFO over prompt.queued)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    // An image-only prompt queued from the hub: its turn's bubble gets the
    // `[image #1]` marker (the engine's `turn.started.prompt` is text-only).
    handler.handleEvent(
      {
        type: 'prompt.queued',
        sessionId: 's1',
        agentId: 'main',
        promptId: 'p1',
        content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }],
      } as any,
      vi.fn(),
    );
    handler.handleEvent(turnStarted(''), vi.fn());
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', content: ' [image #1]' }),
    );
  });

  it('keeps the FIFO aligned across own (deduped) prompts: their queued record is still consumed, not the remote one', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    // Own send → queued (its image), then a REMOTE prompt queued AFTER it.
    handler.handleEvent(
      {
        type: 'prompt.queued',
        sessionId: 's1',
        agentId: 'main',
        promptId: 'own',
        content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,OWN' } }],
      } as any,
      vi.fn(),
    );
    handler.handleEvent(
      {
        type: 'prompt.queued',
        sessionId: 's1',
        agentId: 'main',
        promptId: 'remote',
        content: [{ type: 'image_url', imageUrl: { url: 'data:image/png;base64,REMOTE' } }],
      } as any,
      vi.fn(),
    );
    handler.recordLocalPromptText('own text');
    handler.handleEvent(turnStarted('own text'), vi.fn());
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
    // The REMOTE turn consumes the NEXT queued entry — the marker survives.
    handler.handleEvent(turnStarted('remote text'), vi.fn());
    expect(host.appendTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'user', content: 'remote text [image #1]' }),
    );
  });
});
