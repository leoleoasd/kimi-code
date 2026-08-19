/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

/**
 * The NotifyUser tool's surface, published on the process-global event
 * service (App scope): every runtime surface with a user present consumes it
 * — kap-server's broadcaster fans it out to session WS clients, and the
 * `/remote connect` wiring lifts it onto the hub tunnel.
 */
export interface UserNotifyPayload {
  readonly notificationId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly title: string;
  readonly body?: string;
}

export class UserNotify extends Event2<{ readonly payload: UserNotifyPayload }> {
  static override readonly type = 'event.user.notify';
}
export interface UserNotify {
  readonly payload: UserNotifyPayload;
}
