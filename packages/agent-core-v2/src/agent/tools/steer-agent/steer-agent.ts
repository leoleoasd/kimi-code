import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { z } from 'zod';

import type { AgentTool } from '#/tool/toolContract';

export const SteerAgentToolInputSchema = z
  .object({
    agent_id: z
      .string()
      .min(1)
      .describe(
        "Target subagent's agent_id — from the Agent tool result (the `agent-…` id, NOT a task_id and NOT a source_id).",
      ),
    message: z
      .string()
      .min(1)
      .describe(
        'One plain-text instruction for the running subagent; it arrives as a user-role message at its next step boundary.',
      ),
  })
  .strict();
export type SteerAgentToolInput = z.infer<typeof SteerAgentToolInputSchema>;

export interface ISteerAgentTool extends AgentTool<SteerAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISteerAgentTool: ServiceIdentifier<ISteerAgentTool> =
  createDecorator<ISteerAgentTool>('steerAgentTool');
