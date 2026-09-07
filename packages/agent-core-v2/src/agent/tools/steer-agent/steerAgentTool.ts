import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { isSubagentMeta, subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import DESCRIPTION from './steer-agent.md?raw';
import {
  ISteerAgentTool,
  SteerAgentToolInputSchema,
  type SteerAgentToolInput,
} from './steer-agent';

const STEER_AGENT_TOOL_PARAMETERS = toInputJsonSchema(SteerAgentToolInputSchema);

export class SteerAgentTool implements ISteerAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'SteerAgent' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = STEER_AGENT_TOOL_PARAMETERS;

  private readonly callerAgentId: string;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: SteerAgentToolInput): ToolExecution {
    return {
      description: `Steering a message into running subagent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: () => this.execute(args),
    };
  }

  private async execute(args: SteerAgentToolInput): Promise<ExecutableToolResult> {
    const target = this.lifecycle.get(args.agent_id);
    if (target === undefined) {
      return {
        output: `Agent instance "${args.agent_id}" does not exist — take the id from an Agent tool result (its agent_id, NOT the task_id).`,
        isError: true,
      };
    }
    const meta = (await this.sessionMetadata.read()).agents?.[args.agent_id];
    if (!isSubagentMeta(meta)) {
      return {
        output: `Agent instance "${args.agent_id}" is not your subagent — SteerAgent only messages subagents you spawned. To reach another session's agent, use SendHubMessage instead.`,
        isError: true,
      };
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      return {
        output: `Agent instance "${args.agent_id}" belongs to a different parent agent — only the spawning agent can steer it.`,
        isError: true,
      };
    }
    if (target.accessor.get(IAgentLoopService).status().state !== 'running') {
      return {
        output: [
          `Agent ${args.agent_id} is not running — there is no live turn to steer into.`,
          `Do NOT retry SteerAgent: continue it with the Agent tool — Agent(resume="${args.agent_id}", prompt="...", description="...") — which starts a fresh turn with its full prior context.`,
        ].join('\n'),
        isError: true,
      };
    }
    const caller = this.profile.data().profileName ?? this.callerAgentId;
    const text = [
      `[steered message from your orchestrating agent ("${caller}", agent_id ${this.callerAgentId})]`,
      'The text below was written by the agent that spawned you — it is NOT new input from this session\'s user and does NOT replace your original task. It was steered into your turn mid-flight: incorporate it into your current work, then continue with whatever you were working on.',
      '',
      args.message,
    ].join('\n');
    try {
      const launched = await target.accessor
        .get(IAgentPromptService)
        .submitSteer({ input: [{ type: 'text', text }] });
      if (launched !== undefined) {
        return {
          output: `steered into ${args.agent_id}'s turn (turn_id ${launched.turn_id}) — the subagent reads the message at its next step boundary. Its current turn continues with your message folded in; expect the outcome in its completion notification.`,
        };
      }
      return {
        output: `${args.agent_id}'s active step was shutting down — the message queued and launches as its next turn (same effect as a resume).`,
      };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}

registerAgentToolService(ISteerAgentTool, SteerAgentTool, {
  name: 'SteerAgent',
  domain: 'subagent',
});
