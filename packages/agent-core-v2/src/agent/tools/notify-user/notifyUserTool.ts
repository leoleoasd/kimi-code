/**
 * `tools` domain — `INotifyUserTool` implementation.
 *
 * Publishes `event.user.notify` on the PROCESS-GLOBAL event service (App
 * scope): every runtime surface with a user present consumes it from there —
 * kap-server's broadcaster fans it out to session WS clients, and the
 * `/remote connect` wiring lifts it onto the hub tunnel so the (hub) web UI
 * can show an OS-level notification. The conversation is never polluted:
 * the tool result is a one-line ack, nothing lands in the transcript. Bound
 * at Agent scope; every agent (main or spawned) may notify.
 */

import { toInputJsonSchema } from '#/tool/input-schema';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventService } from '#/app/event/event';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import DESCRIPTION from './notify-user.md?raw';
import {
  INotifyUserTool,
  NotifyUserToolInputSchema,
  type NotifyUserToolInput,
} from './notify-user';

export class NotifyUserTool implements INotifyUserTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'NotifyUser' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NotifyUserToolInputSchema);

  constructor(
    @IEventService private readonly events: IEventService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: NotifyUserToolInput): ToolExecution {
    return {
      description: 'Notifying the user',
      approvalRule: this.name,
      execute: async () => {
        this.events.publish({
          type: 'event.user.notify',
          payload: {
            notificationId: `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId: this.session.sessionId,
            agentId: this.scopeContext.agentId,
            title: args.title,
            body: args.body,
          },
        });
        return { output: `notification sent: ${args.title}` };
      },
    };
  }
}

registerAgentToolService(INotifyUserTool, NotifyUserTool, {
  name: 'NotifyUser',
  domain: 'notify',
});
