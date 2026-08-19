
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
