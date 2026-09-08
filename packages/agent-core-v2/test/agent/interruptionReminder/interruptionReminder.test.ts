import { describe, expect, it } from 'vitest';

import { EventBusService } from '#/app/event/eventBusService';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { IAgentGoalService } from '#/agent/goal/goal';
import type { GoalSnapshot } from '#/agent/goal/types';
import { AgentInterruptionReminderService } from '#/agent/interruptionReminder/interruptionReminderService';
import { INTERRUPTION_REMINDER_VARIANT } from '#/agent/interruptionReminder/interruptionReminderOps';
import { TurnEnded } from '#/agent/loop/turnOps';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';

function snapshot(status: GoalSnapshot['status']): GoalSnapshot {
  return { goalId: 'g1', objective: 'ship x', status, turnsUsed: 0, tokensUsed: 0 } as GoalSnapshot;
}

async function interruptWith(goal: GoalSnapshot | null, existing?: Partial<ContextMessage>): Promise<string[]> {
  const bus = new EventBusService();
  const appended: string[] = [];
  const context = {
    get: () => (existing === undefined ? [] : [existing as ContextMessage]),
  } as unknown as IAgentContextMemoryService;
  const reminders = {
    appendSystemReminder: (text: string) => void appended.push(text),
  } as unknown as IAgentSystemReminderService;
  const agentState = { contributeState: () => undefined } as unknown as IAgentStateService;
  const goalService = { getGoal: () => ({ goal }) } as unknown as IAgentGoalService;
  void new AgentInterruptionReminderService(bus, context, reminders, agentState, goalService);
  bus.publish(new TurnEnded({ turnId: 1, reason: 'cancelled', interruptReason: 'user_cancelled' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return appended;
}

describe('AgentInterruptionReminderService', () => {
  it('plain text without a goal — the historical wording is byte-identical', async () => {
    const appended = await interruptWith(null);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toBe(
      "The previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.",
    );
    expect(appended[0]).not.toContain('goal');
  });

  it('an active goal appends the goal-untouched suffix — interruption is course correction', async () => {
    const appended = await interruptWith(snapshot('active'));
    expect(appended).toHaveLength(1);
    expect(appended[0]).toContain('A goal is active and was NOT paused');
    expect(appended[0]).toContain('UpdateGoal');
  });

  it('paused/blocked goals get the plain wording (nothing live to manage)', async () => {
    expect((await interruptWith(snapshot('paused')))[0]).not.toContain('goal is active');
    expect((await interruptWith(snapshot('blocked')))[0]).not.toContain('goal is active');
  });

  it('engine-initiated cancellations (abort, max steps, filter) never remind', async () => {
    const bus = new EventBusService();
    const appended: string[] = [];
    const context = { get: () => [] } as unknown as IAgentContextMemoryService;
    const reminders = {
      appendSystemReminder: (text: string) => void appended.push(text),
    } as unknown as IAgentSystemReminderService;
    const agentState = { contributeState: () => undefined } as unknown as IAgentStateService;
    const goalService = {
      getGoal: () => ({ goal: snapshot('active') }),
    } as unknown as IAgentGoalService;
    void new AgentInterruptionReminderService(bus, context, reminders, agentState, goalService);
    for (const reason of ['aborted', 'max_steps', 'filtered'] as const) {
      bus.publish(new TurnEnded({ turnId: 1, reason: 'cancelled', interruptReason: reason }));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appended).toHaveLength(0);
  });

  it('an existing same-variant reminder silences a repeat append', async () => {
    const appended = await interruptWith(snapshot('active'), {
      origin: { kind: 'injection', variant: INTERRUPTION_REMINDER_VARIANT },
    });
    expect(appended).toHaveLength(0);
  });
});
