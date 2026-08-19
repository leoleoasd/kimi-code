/**
 * `SessionEventWiring` — the in-process v1 edge over the v2 per-agent event
 * bus. Covers the status-snapshot fold: v2 emits `agent.status.updated` in
 * slices and the model slice rides only the bind-time emission, so the
 * wiring merges a consistent usage + context + model snapshot into every
 * status event (mirrors kap-server's broadcaster bridge).
 * Run: pnpm exec vitest run test/session-event-wiring.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { Event } from '@moonshot-ai/agent-core';
import {
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentTokenCountingService,
  IAgentUsageService,
  IEventBus,
  ISessionApprovalService,
  ISessionInteractionService,
  ISessionQuestionService,
  type IAgentScopeHandle,
  type Interaction,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';

import { SessionEventWiring, type SessionEventSink } from '#/v2/session-wiring';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type FakeBusEvent = { type: string } & Record<string, unknown>;

class FakeAgentBus {
  private handlers: Array<(e: FakeBusEvent) => void> = [];
  subscribe(handler: (e: FakeBusEvent) => void): { dispose(): void } {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const i = this.handlers.indexOf(handler);
        if (i >= 0) this.handlers.splice(i, 1);
      },
    };
  }
  emit(e: FakeBusEvent): void {
    for (const h of [...this.handlers]) h(e);
  }
}

class FakeAgentHandle {
  readonly kind = 2;
  readonly bus = new FakeAgentBus();
  readonly accessor;
  private readonly services = new Map<unknown, unknown>();
  constructor(readonly id: string) {
    this.services.set(IEventBus, this.bus);
    this.accessor = {
      get: (token: unknown) => this.services.get(token),
    };
  }
  set(token: unknown, service: unknown): void {
    this.services.set(token, service);
  }
  dispose(): void {}
}

function makeSession(agents: FakeAgentHandle[]): ISessionScopeHandle {
  const lifecycle = {
    list: () => agents,
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  const interactions = {
    onDidChangePending: () => ({ dispose: () => {} }),
    listPending: () => [],
  };
  const accessor = {
    get: (token: unknown): unknown => {
      if (token === IAgentLifecycleService) return lifecycle;
      if (token === ISessionInteractionService) return interactions;
      return undefined;
    },
  };
  return { id: 's1', kind: 1, accessor, dispose: () => {} } as unknown as ISessionScopeHandle;
}

function collectingSink(): { sink: SessionEventSink; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    sink: {
      receiveEvent: (event) => {
        events.push(event);
      },
      requestApproval: () => Promise.resolve('cancelled' as never),
      requestQuestion: () => Promise.resolve(null),
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
    },
  };
}

const USAGE = {
  total: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
};

function bindStatusServices(agent: FakeAgentHandle, model: string): void {
  agent.set(IAgentTokenCountingService, { statusSize: () => 10 });
  agent.set(IAgentProfileService, {
    getModel: () => model,
    getModelCapabilities: () => ({ max_context_tokens: 128_000 }),
  });
  agent.set(IAgentUsageService, { status: () => USAGE });
}

// ---------------------------------------------------------------------------
// External resolution (the cancel-elsewhere chain): a bridged approval /
// question settled through ANOTHER surface (kap-server's REST answer routes,
// a dismiss, turn cancel) must unwind the client's pending prompt instead of
// leaving it open, and the client's own answer must still write through.
// ---------------------------------------------------------------------------

class FakeInteractionKernel {
  private readonly pending = new Map<string, Interaction>();
  private readonly changeHandlers = new Set<() => void>();
  private readonly resolveHandlers = new Set<(e: { id: string; response: unknown }) => void>();
  onDidChangePending(handler: () => void): { dispose(): void } {
    this.changeHandlers.add(handler);
    return { dispose: () => this.changeHandlers.delete(handler) };
  }
  onDidResolve(handler: (e: { id: string; response: unknown }) => void): { dispose(): void } {
    this.resolveHandlers.add(handler);
    return { dispose: () => this.resolveHandlers.delete(handler) };
  }
  listPending(): readonly Interaction[] {
    return [...this.pending.values()];
  }
  park(interaction: Interaction): void {
    this.pending.set(interaction.id, interaction);
    for (const handler of [...this.changeHandlers]) handler();
  }
  respond(id: string, response: unknown): void {
    if (!this.pending.delete(id)) return;
    for (const handler of [...this.resolveHandlers]) handler({ id, response });
  }
}

interface WiredServices {
  readonly kernel: FakeInteractionKernel;
  readonly questions: { answered: Array<{ id: string; result: unknown }>; dismissed: string[] };
  readonly approvals: { decided: Array<{ id: string; response: unknown }> };
}

function makeSessionWithInteractions(): { session: ISessionScopeHandle; services: WiredServices } {
  const kernel = new FakeInteractionKernel();
  const services: WiredServices = {
    kernel,
    questions: {
      answered: [],
      dismissed: [],
    },
    approvals: {
      decided: [],
    },
  };
  const questionService = {
    answer: (id: string, result: unknown): void => {
      services.questions.answered.push({ id, result });
      kernel.respond(id, result);
    },
    dismiss: (id: string): void => {
      services.questions.dismissed.push(id);
      kernel.respond(id, null);
    },
  };
  const approvalService = {
    decide: (id: string, response: unknown): void => {
      services.approvals.decided.push({ id, response });
      kernel.respond(id, response);
    },
  };
  const lifecycle = {
    list: () => [],
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  const accessor = {
    get: (token: unknown): unknown => {
      if (token === IAgentLifecycleService) return lifecycle;
      if (token === ISessionInteractionService) return kernel;
      if (token === ISessionQuestionService) return questionService;
      if (token === ISessionApprovalService) return approvalService;
      return undefined;
    },
  };
  return {
    session: { id: 's1', kind: 1, accessor, dispose: () => {} } as unknown as ISessionScopeHandle,
    services,
  };
}

function openEndedSink(): {
  sink: SessionEventSink;
  questioned: string[];
  approved: string[];
  cancelledQuestions: string[];
  cancelledApprovals: string[];
} {
  const questioned: string[] = [];
  const approved: string[] = [];
  const cancelledQuestions: string[] = [];
  const cancelledApprovals: string[] = [];
  return {
    questioned,
    approved,
    cancelledQuestions,
    cancelledApprovals,
    sink: {
      receiveEvent: () => {},
      // The client never answers on its own — simulates an open panel.
      requestApproval: (request) => {
        approved.push(request.toolCallId);
        return new Promise(() => {});
      },
      requestQuestion: (request) => {
        questioned.push(request.toolCallId ?? '');
        return new Promise(() => {});
      },
      toolCall: () => Promise.resolve({ output: 'not supported', isError: true }),
      cancelApproval: ({ interactionId }) => {
        cancelledApprovals.push(interactionId);
      },
      cancelQuestion: ({ interactionId }) => {
        cancelledQuestions.push(interactionId);
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function questionInteraction(id: string): Interaction {
  return {
    id,
    kind: 'question',
    payload: {
      toolCallId: id,
      questions: [{ question: 'Pick one', header: 'Q', options: [{ label: 'A' }, { label: 'B' }] }],
    },
    origin: {},
    createdAt: Date.now(),
  };
}

function approvalInteraction(id: string): Interaction {
  return {
    id,
    kind: 'approval',
    payload: { toolCallId: id, toolName: 'Bash', action: 'run', display: { kind: 'brief' } },
    origin: {},
    createdAt: Date.now(),
  };
}

describe('SessionEventWiring external interaction resolution', () => {
  it('unwinds the client question dialog when the interaction resolves elsewhere', async () => {
    const { session, services } = makeSessionWithInteractions();
    const recorder = openEndedSink();
    const wiring = new SessionEventWiring(session, recorder.sink);
    try {
      services.kernel.park(questionInteraction('tc-q1'));
      await flush();
      expect(recorder.questioned).toEqual(['tc-q1']);

      // The answer arrives through ANOTHER surface (e.g. kap-server's REST
      // question route): the pending promise settles, the client panel must
      // be told to close, and nothing may write a second answer back.
      services.kernel.respond('tc-q1', { answers: { 'Pick one': 'A' } });
      await flush();
      await flush();

      expect(recorder.cancelledQuestions).toEqual(['tc-q1']);
      expect(recorder.cancelledApprovals).toEqual([]);
      expect(services.questions.answered).toEqual([]);
      expect(services.questions.dismissed).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  it("writes the client's own answer back and never fires cancelQuestion", async () => {
    const { session, services } = makeSessionWithInteractions();
    const recorder = openEndedSink();
    recorder.sink.requestQuestion = () => Promise.resolve({ answers: { 'Pick one': 'B' } });
    const wiring = new SessionEventWiring(session, recorder.sink);
    try {
      services.kernel.park(questionInteraction('tc-q2'));
      await flush();
      await flush();

      expect(services.questions.answered).toHaveLength(1);
      expect(services.questions.answered[0]).toMatchObject({ id: 'tc-q2' });
      expect(recorder.cancelledQuestions).toEqual([]);
      expect(services.kernel.listPending()).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  it('unwinds the client approval panel when the interaction resolves elsewhere', async () => {
    const { session, services } = makeSessionWithInteractions();
    const recorder = openEndedSink();
    const wiring = new SessionEventWiring(session, recorder.sink);
    try {
      services.kernel.park(approvalInteraction('tc-a1'));
      await flush();
      expect(recorder.approved).toEqual(['tc-a1']);

      services.kernel.respond('tc-a1', { decision: 'approved' });
      await flush();
      await flush();

      expect(recorder.cancelledApprovals).toEqual(['tc-a1']);
      expect(recorder.cancelledQuestions).toEqual([]);
      expect(services.approvals.decided).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });

  it("writes the client's own approval decision back and never fires cancelApproval", async () => {
    const { session, services } = makeSessionWithInteractions();
    const recorder = openEndedSink();
    recorder.sink.requestApproval = () => Promise.resolve({ decision: 'approved' } as never);
    const wiring = new SessionEventWiring(session, recorder.sink);
    try {
      services.kernel.park(approvalInteraction('tc-a2'));
      await flush();
      await flush();

      expect(services.approvals.decided).toHaveLength(1);
      expect(recorder.cancelledApprovals).toEqual([]);
    } finally {
      wiring.dispose();
    }
  });
});


describe('SessionEventWiring status snapshot fold', () => {
  it('folds a consistent usage + context + model snapshot into every status event', () => {
    const sub = new FakeAgentHandle('agent-1');
    bindStatusServices(sub, 'sub-model');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      // The v2 model slice rides only the subagent's bind-time emission, which
      // reaches clients before `subagent.spawned` and is dropped there; a
      // later usage-only slice must still carry the model at this edge.
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
      // Non-status events pass through untouched.
      sub.bus.emit({ type: 'assistant.delta', delta: 'Hi', time: 1_700_000_000_123 });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'agent.status.updated',
      sessionId: 's1',
      agentId: 'agent-1',
      usage: USAGE,
      contextTokens: 10,
      maxContextTokens: 128_000,
      model: 'sub-model',
    });
    expect(events[1]).toMatchObject({
      type: 'assistant.delta',
      delta: 'Hi',
      time: 1_700_000_000_123,
    });
    expect(events[1]).not.toHaveProperty('model');
  });

  it('passes status events through unchanged when the agent services are incomplete', () => {
    const sub = new FakeAgentHandle('agent-1');
    // No profile/usage/context/wire services bound — nothing to fold in.
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      sub.bus.emit({ type: 'agent.status.updated', usage: USAGE });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'agent.status.updated', usage: USAGE });
    expect(events[0]).not.toHaveProperty('model');
  });

  it('strips the internal promptAttachments field from turn.started', () => {
    const sub = new FakeAgentHandle('agent-1');
    const { sink, events } = collectingSink();
    const wiring = new SessionEventWiring(makeSession([sub]), sink);
    try {
      // `promptAttachments` is transcript-projection metadata: kap-server
      // strips it from the WS wire event, so SDK consumers must not see it
      // either.
      sub.bus.emit({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'user' },
        prompt: 'describe this',
        promptAttachments: [{ kind: 'image', fileId: 'f_1' }],
      });
    } finally {
      wiring.dispose();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'turn.started',
      turnId: 1,
      sessionId: 's1',
      agentId: 'agent-1',
      prompt: 'describe this',
    });
    expect(events[0]).not.toHaveProperty('promptAttachments');
  });
});
