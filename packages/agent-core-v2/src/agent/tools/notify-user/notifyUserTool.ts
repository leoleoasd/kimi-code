
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
import { UserNotify } from './userNotifyEvent';

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
        this.events.publish(
          new UserNotify({
            payload: {
              notificationId: `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
              sessionId: this.session.sessionId,
              agentId: this.scopeContext.agentId,
              title: args.title,
              body: args.body,
            },
          }),
        );
        return { output: `notification sent: ${args.title}` };
      },
    };
  }
}

registerAgentToolService(INotifyUserTool, NotifyUserTool, {
  name: 'NotifyUser',
  domain: 'notify',
});
