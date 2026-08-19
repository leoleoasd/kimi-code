
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
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
          'The text below was written by another agent — it is NOT input from this session\'s user. It was steered into your turn mid-flight: answer it, then continue with whatever you were working on. To reply, send a SendHubMessage to that session.',
          '',
          args.message,
        ].join('\n');
        try {
          const receipt = await this.hub.sendToSession({
            agentId: owner.agentId,
            sessionId: args.session_id,
            text,
            steer: true,
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
      return ' — the agent has it now (steered into its active turn, or launched as a new turn)';
    case 'queued':
      return ' — nothing to steer into right now (e.g. a compaction is holding the context); the message waits in its FIFO';
    case 'blocked':
      return " — that session is waiting on its user's input; the message queues behind that";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerAgentToolService(ISendHubMessageTool, SendHubMessageTool, {
  name: 'SendHubMessage',
  domain: 'session',
});
