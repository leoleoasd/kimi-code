
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { z } from 'zod';

import type { AgentTool } from '#/tool/toolContract';

export const SendHubMessageToolInputSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe('Target session id — take it from ListHubSessions output.'),
    message: z
      .string()
      .min(1)
      .describe(
        'Plain-text message for the agent running that session (you write the content; it arrives as a user-role message).',
      ),
  })
  .strict();
export type SendHubMessageToolInput = z.infer<typeof SendHubMessageToolInputSchema>;

export interface ISendHubMessageTool extends AgentTool<SendHubMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISendHubMessageTool: ServiceIdentifier<ISendHubMessageTool> =
  createDecorator<ISendHubMessageTool>('sendHubMessageTool');
