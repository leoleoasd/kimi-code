/**
 * `tools` domain — `INotifyUserTool` contract.
 *
 * Public contract of the NotifyUser tool: the input schema the model calls
 * with and the Agent-scope identifier used to resolve the implementation
 * through the container. The tool pushes an out-of-band USER notification —
 * a deck nudge (browser Notification / TUI notice), NOT a transcript message:
 * the agent calls it when the user's attention is needed elsewhere (long work
 * done, waiting on an answer, a failure worth surfacing). Bound at Agent
 * scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const NotifyUserToolInputSchema = z
  .object({
    title: z.string().min(1).max(80).describe('Short notification headline (one line).'),
    body: z.string().min(1).max(300).describe('One or two sentences of detail.'),
  })
  .strict();

export type NotifyUserToolInput = z.infer<typeof NotifyUserToolInputSchema>;

export interface INotifyUserTool extends AgentTool<NotifyUserToolInput> {
  readonly _serviceBrand: undefined;
}
export const INotifyUserTool = createDecorator<INotifyUserTool>('notifyUserTool');
