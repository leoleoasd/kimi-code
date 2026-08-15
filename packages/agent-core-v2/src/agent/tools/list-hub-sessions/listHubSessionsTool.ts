/**
 * `tools` domain — `IListHubSessionsTool` implementation.
 *
 * Reads the live connection + roster through `hubConnection`
 * (`IHubConnectionService`); the output is a compact, model-oriented listing
 * of every connected agent's exposed session ids. Sessions bridged from this
 * process are flagged so the model does not target its own machine. Bound at
 * Agent scope.
 */

import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import {
  type HubConnection,
  type HubRemoteAgent,
  IHubConnectionService,
} from '#/hub/hubConnection';
import { toInputJsonSchema } from '#/tool/input-schema';
import { type ToolExecution } from '#/tool/toolContract';

import DESCRIPTION from './list-hub-sessions.md?raw';
import {
  IListHubSessionsTool,
  ListHubSessionsToolInputSchema,
  type ListHubSessionsToolInput,
} from './list-hub-sessions';

export class ListHubSessionsTool implements IListHubSessionsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ListHubSessions' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ListHubSessionsToolInputSchema);

  constructor(@IHubConnectionService private readonly hub: IHubConnectionService) {}

  resolveExecution(_args: ListHubSessionsToolInput): ToolExecution {
    return {
      description: 'Listing hub sessions',
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
        let agents: HubRemoteAgent[];
        try {
          agents = await this.hub.listRemoteAgents();
        } catch (error) {
          return { output: errorMessage(error), isError: true };
        }
        return { output: formatRoster(agents, connection) };
      },
    };
  }
}

export function formatRoster(
  agents: readonly HubRemoteAgent[],
  connection: HubConnection,
): string {
  if (agents.length === 0) {
    return `no agents are currently connected to ${connection.hubUrl}.`;
  }
  const lines: string[] = [`${String(agents.length)} agent(s) on ${connection.hubUrl}:`];
  for (const agent of agents) {
    const details: string[] = [];
    if (agent.platform !== '') details.push(`${agent.platform}/${agent.arch}`);
    if (agent.version !== undefined) details.push(`kimi ${agent.version}`);
    if (agent.cwd !== undefined) details.push(`cwd ${agent.cwd}`);
    lines.push(
      `\n"${agent.name}" (${agent.agentId})${details.length === 0 ? '' : ` — ${details.join(', ')}`}`,
    );
    if (agent.sessionIds.length === 0) {
      lines.push(
        agent.legacy
          ? '  (legacy connection — publishes no session list, cannot be targeted with SendHubMessage)'
          : '  (exposes no sessions)',
      );
      continue;
    }
    for (const sessionId of agent.sessionIds) {
      const title = agent.sessionTitles[sessionId];
      const label = title === undefined ? sessionId : `"${title}" (${sessionId})`;
      lines.push(
        `  - ${label}${connection.sessionIds.includes(sessionId) ? '  (bridged from this machine)' : ''}`,
      );
    }
  }
  lines.push('\ntarget a session id above with SendHubMessage.');
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerAgentToolService(IListHubSessionsTool, ListHubSessionsTool, {
  name: 'ListHubSessions',
  domain: 'session',
});
