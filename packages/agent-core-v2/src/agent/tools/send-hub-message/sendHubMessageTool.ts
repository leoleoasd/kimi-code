/**
 * `tools` domain — `ISendHubMessageTool` implementation.
 *
 * Owns the delivery semantics: locate the owning agent for the target
 * session in the hub roster, wrap the message in a provenance header (so the
 * receiving agent knows it came from another agent and how to reply), and
 * submit it through `hubConnection` (`IHubConnectionService`). Agent-scope
 * context (`ISessionContext`) supplies the sender identity; hub failures map
 * to `isError` results rendered for the model. Bound at Agent scope.
 */

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import {
  type HubPromptStatus,
  type HubRemoteAgent,
  IHubConnectionService,
} from '#/hub/hubConnection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { type ToolExecution } from '#/tool/toolContract';

import DESCRIPTION from './send-hub-message.md?raw';
import {
  ISendHubMessageTool,
  SendHubMessageToolInputSchema,
  type SendHubMessageToolInput,
} from './send-hub-message';

export class SendHubMessageTool implements ISendHubMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SendHubMessage' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SendHubMessageToolInputSchema);

  constructor(
    @IHubConnectionService private readonly hub: IHubConnectionService,
    @ISessionContext private readonly session: ISessionContext,
  ) {}

  resolveExecution(args: SendHubMessageToolInput): ToolExecution {
    return {
      description: `Messaging session ${args.session_id} via the hub`,
      approvalRule: this.name,
      execute: async () => {
        const connection = this.hub.connection();
        if (connection === undefined) {
          return {
            output:
              'not connected to a kimi hub — connect first (`kimi remote connect` or the TUI\'s `/remote connect`), and this tool becomes usable.',
            isError: true,
          };
        }
        if (args.session_id === this.session.sessionId) {
          return {
            output: 'the target is your own session — SendHubMessage messages OTHER sessions.',
            isError: true,
          };
        }
        let agents: HubRemoteAgent[];
        try {
          agents = await this.hub.listRemoteAgents();
        } catch (error) {
          return { output: errorMessage(error), isError: true };
        }
        const owners = agents.filter((agent) => agent.sessionIds.includes(args.session_id));
        if (owners.length === 0) {
          return {
            output: `session ${args.session_id} is not exposed on the hub right now — call ListHubSessions for reachable targets.`,
            isError: true,
          };
        }
        if (owners.length > 1) {
          return {
            output: `session ${args.session_id} is exposed by more than one agent — refusing to guess; report this to the user.`,
            isError: true,
          };
        }
        const owner = owners[0]!;
        const senderName = connection.agentName ?? 'an agent';
        const text = [
          `[kimi-hub message from ${senderName} (session ${this.session.sessionId})]`,
          'The text below was written by another agent — it is NOT input from this session\'s user. To reply, send a SendHubMessage to that session.',
          '',
          args.message,
        ].join('\n');
        try {
          const receipt = await this.hub.sendToSession({
            agentId: owner.agentId,
            sessionId: args.session_id,
            text,
          });
          return {
            output: `message delivered to ${owner.name}'s session ${args.session_id} (status: ${receipt.status}${statusNote(receipt.status)})`,
          };
        } catch (error) {
          return { output: errorMessage(error), isError: true };
        }
      },
    };
  }
}

function statusNote(status: HubPromptStatus): string {
  switch (status) {
    case 'running':
      return ' — the agent picked it up immediately';
    case 'queued':
      return ' — the agent is mid-turn; it reads queued messages right after';
    case 'blocked':
      return " — that session is waiting on its user's input; the message queues behind that";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  ISendHubMessageTool,
  SendHubMessageTool,
  ScopeActivation.OnDemand,
  'tools',
);
