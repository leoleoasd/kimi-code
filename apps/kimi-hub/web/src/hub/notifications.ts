/**
 * OS-level user notifications for the hub UI — the rendering half of the
 * NotifyUser tool's chain: engine event → tunnel `notify` frame → hub stream
 * broadcast → here.
 *
 * Goes through the PWA service worker (`registration.showNotification`), NOT
 * `new Notification()`: that is the ONLY form Android Chrome and installed
 * iOS PWAs accept, and it routes clicks through the SW's `notificationclick`
 * listener (sw.js) back to this page via `postMessage`.
 *
 * No closed-tab delivery: that needs Web Push (VAPID + a push service),
 * deliberately out of scope.
 */

import type { NotifyPayload } from './stream';

/** The sw.js → page click-through message's shape. */
export interface NotificationClickMessage {
  readonly type: 'notification-click';
  readonly agentName: string;
  readonly sessionId: string;
}

/**
 * Current permission as a tri-state: 'granted' | 'denied' | 'prompt-needed'
 * | 'unsupported' (older Safari / non-secure contexts).
 */
export function notificationState(): 'granted' | 'denied' | 'prompt-needed' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return 'prompt-needed';
}

/** The bell's click: request; resolves to the follow-up state. */
export async function askNotificationPermission(): Promise<ReturnType<typeof notificationState>> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    await Notification.requestPermission();
  } catch {
    // Old callbacks-only implementations — read the final state either way.
  }
  return notificationState();
}

/**
 * Show one hub notification. `tag` = notificationId: an identical frame
 * re-delivered (an echo through the session-relay path AND the hub stream
 * route, or a retry) REPLACES instead of stacking.
 */
export async function showHubNotification(notify: NotifyPayload): Promise<void> {
  if (notificationState() !== 'granted') return;
  const registration = await navigator.serviceWorker.ready.catch(() => undefined);
  if (registration === undefined) return;
  await registration.showNotification(notify.title, {
    body: `${notify.body}\n${notify.agentName}`,
    tag: `kimi-hub/${notify.notificationId}`,
    data: {
      type: 'notification-click',
      agentName: notify.agentName,
      sessionId: notify.sessionId,
    } satisfies NotificationClickMessage,
  });
}
