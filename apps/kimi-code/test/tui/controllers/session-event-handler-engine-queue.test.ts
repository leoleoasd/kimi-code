import { describe, expect, it, vi } from 'vitest';

import {
  SessionEventHandler,
  extractEngineQueuedText,
  removeEngineQueuedPrompts,
  upsertEngineQueuedPrompt,
} from '#/tui/controllers/session-event-handler';
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
        engineQueuedPrompts: [] as { promptId: string; text: string }[],
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
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    updateQueueDisplay: vi.fn(),
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

/** The v2 engine's `prompt.queued` — not part of the v1 Event union. */
function promptQueued(promptId: string, content: unknown[]) {
  return { type: 'prompt.queued', sessionId: 's1', agentId: 'main', promptId, content } as any;
}

function promptSubmitted(
  promptId: string,
  status: 'running' | 'queued' | 'blocked',
  content: unknown[] = [{ type: 'text', text: 'queued from the hub' }],
) {
  return {
    type: 'prompt.submitted',
    sessionId: 's1',
    agentId: 'main',
    promptId,
    userMessageId: `m-${promptId}`,
    status,
    content,
    createdAt: '2026-01-01T00:00:00Z',
  } as any;
}

function textPart(text: string) {
  return { type: 'text', text };
}

const engineQueue = (host: any) => host.state.appState.engineQueuedPrompts as {
  promptId: string;
  text: string;
}[];

describe('SessionEventHandler — engine-side prompt queue', () => {
  it('shows a prompt queued engine-side by another surface (v2 prompt.queued)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptQueued('p1', [textPart('fix the failing   test'), textPart('now please')]), vi.fn());
    expect(engineQueue(host)).toEqual([
      { promptId: 'p1', text: 'fix the failing test now please' },
    ]);
    expect(host.updateQueueDisplay).toHaveBeenCalled();
  });

  it('keeps FIFO order for multiple engine-queued prompts', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptQueued('p1', [textPart('first')]), vi.fn());
    handler.handleEvent(promptQueued('p2', [textPart('second')]), vi.fn());
    expect(engineQueue(host).map((e) => e.promptId)).toEqual(['p1', 'p2']);
  });

  it('shows prompt.submitted with status queued (v1 wire shape)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    expect(engineQueue(host)).toEqual([{ promptId: 'p1', text: 'queued from the hub' }]);
  });

  it('replaces the entry on a repeated promptId instead of duplicating it', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued', [textPart('v1')]), vi.fn());
    handler.handleEvent(promptSubmitted('p1', 'queued', [textPart('v2')]), vi.fn());
    expect(engineQueue(host)).toEqual([{ promptId: 'p1', text: 'v2' }]);
  });

  it('drops the entry when the queued prompt launches (prompt.submitted running)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    handler.handleEvent(promptSubmitted('p1', 'running'), vi.fn());
    expect(engineQueue(host)).toEqual([]);
  });

  it('drops entries on prompt.completed / prompt.aborted', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    handler.handleEvent(promptSubmitted('p2', 'queued'), vi.fn());
    handler.handleEvent(
      { type: 'prompt.completed', sessionId: 's1', agentId: 'main', promptId: 'p1', finishedAt: '2026-01-01T00:00:01Z' } as any,
      vi.fn(),
    );
    expect(engineQueue(host).map((e) => e.promptId)).toEqual(['p2']);
    handler.handleEvent(
      { type: 'prompt.aborted', sessionId: 's1', agentId: 'main', promptId: 'p2', abortedAt: '2026-01-01T00:00:02Z' } as any,
      vi.fn(),
    );
    expect(engineQueue(host)).toEqual([]);
  });

  it('drops every absorbed prompt on prompt.steered', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    handler.handleEvent(promptSubmitted('p2', 'queued'), vi.fn());
    handler.handleEvent(
      { type: 'prompt.steered', sessionId: 's1', agentId: 'main', activePromptId: 'p0', promptIds: ['p1', 'p2'], content: [textPart('merged')], steeredAt: '2026-01-01T00:00:01Z' } as any,
      vi.fn(),
    );
    expect(engineQueue(host)).toEqual([]);
  });

  it('leaves the queue alone across turn.ended (draining is signaled by prompt events)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    host.updateQueueDisplay.mockClear();
    handler.handleEvent(
      { type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 1, reason: 'completed' } as any,
      vi.fn(),
    );
    expect(engineQueue(host)).toEqual([{ promptId: 'p1', text: 'queued from the hub' }]);
    expect(host.updateQueueDisplay).not.toHaveBeenCalled();
  });

  it('does not repaint for events about prompts it is not tracking', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    host.setAppState.mockClear();
    host.updateQueueDisplay.mockClear();
    handler.handleEvent(
      { type: 'prompt.completed', sessionId: 's1', agentId: 'main', promptId: 'other', finishedAt: '2026-01-01T00:00:01Z' } as any,
      vi.fn(),
    );
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.updateQueueDisplay).not.toHaveBeenCalled();
    // A repeated queued event with identical text is stable too.
    handler.handleEvent(promptSubmitted('p1', 'queued'), vi.fn());
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.updateQueueDisplay).not.toHaveBeenCalled();
  });
});

describe('extractEngineQueuedText', () => {
  it('collapses whitespace and caps at ~40 chars with an ellipsis', () => {
    const long = 'word '.repeat(12).trim();
    const text = extractEngineQueuedText([textPart(long)]);
    expect(text).toBe(`${'word '.repeat(8)}…`);
    expect(text.length).toBe(41);
  });

  it('joins multiple text parts with a space and strips newlines', () => {
    expect(extractEngineQueuedText([textPart('line one\n'), textPart('  line two')])).toBe(
      'line one line two',
    );
  });

  it('falls back to 🖼 for media-only content', () => {
    expect(extractEngineQueuedText([{ type: 'image_url', url: 'file:///x.png' }])).toBe('🖼');
    expect(extractEngineQueuedText([])).toBe('🖼');
    expect(extractEngineQueuedText([textPart('   ')])).toBe('🖼');
  });
});

describe('engine-queue list transitions', () => {
  it('upsert returns the same list when nothing changed', () => {
    const list = [{ promptId: 'p1', text: 'x' }];
    expect(upsertEngineQueuedPrompt(list, { promptId: 'p1', text: 'x' })).toBe(list);
    expect(upsertEngineQueuedPrompt(list, { promptId: 'p2', text: 'y' })).not.toBe(list);
    expect(removeEngineQueuedPrompts(list, ['nope'])).toBe(list);
    expect(removeEngineQueuedPrompts(list, ['p1'])).not.toBe(list);
  });
});
