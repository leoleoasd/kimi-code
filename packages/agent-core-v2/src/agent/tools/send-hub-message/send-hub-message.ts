/**
 * `tools` domain — `ISendHubMessageTool` contract.
 *
 * Delivers a plain-text message from this agent to the agent running another
 * session exposed on the same kimi hub, by submitting a wrapped user-role
 * prompt through the hub's proxy (`POST /agents/{agentId}/api/v1/sessions/
 * {sessionId}/prompts` with `steer: true` — a busy session gets the message
 * injected into its active turn at the next step boundary, like the TUI's
 * mid-turn typing; an idle one starts a fresh turn). Hub-gated, registered
 * per agent by the remote-control connector alongside `ListHubSessions`.
 * Bound at Agent scope.
 */

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
