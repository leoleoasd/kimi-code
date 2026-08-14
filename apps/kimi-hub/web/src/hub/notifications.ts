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
 * Closed-tab delivery goes through Web Push (sw.js `push` handler); with any
 * hub window open the push side stays silent and THIS page channel renders
 * instead, so a device never shows both.
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

/**
 * Web Push handshake: fetch the hub's VAPID public key, subscribe, upsert the
 * registration. Server-side stores it so EVEN WITH THE PAGE CLOSED the hub
 * can `sendNotification` to this device. Idempotent: upserts reuse the
 * existing subscription (endpoint-equal) on every page load — UNLESS the hub
 * rotated its VAPID keypair: a subscription is bound to the application
 * server key it was created with (APNs answers every send for a mismatched
 * key with 400 VapidPkHashMismatch), so a stale one is unsubscribed and
 * re-created with the current key. Notification permission was granted on
 * this device already, so the re-subscribe needs no new prompt.
 */
export async function ensurePushSubscription(
  hubBaseUrl: string,
  token: string,
): Promise<boolean> {
  if (notificationState() !== 'granted') return false;
  if (typeof navigator.serviceWorker === 'undefined') return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const vapidRes = await fetch(`${hubBaseUrl}/hub/api/push/vapid`, {
      headers: token !== '' ? { authorization: `Bearer ${token}` } : {},
    });
    const envelope = (await vapidRes.json()) as { data?: { publicKey?: string } };
    const publicKey = envelope.data?.publicKey;
    if (typeof publicKey !== 'string' || publicKey === '') return false;
    const applicationServerKey = urlBase64ToUint8Array(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription !== null && !applicationServerKeysEqual(subscription.options.applicationServerKey, applicationServerKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as unknown as BufferSource,
    });
    await fetch(`${hubBaseUrl}/hub/api/push/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token !== '' ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(subscription.toJSON()),
    });
    return true;
  } catch {
    // Push unavailable (plain tab iOS, no HTTPS, missing push capability) — the
    // roster-stream channel still covers the open page.
    return false;
  }
}

/** Byte equality between the stored subscription's key and the hub's current VAPID key. */
function applicationServerKeysEqual(existing: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (existing === null || existing.byteLength !== wanted.byteLength) return false;
  const existingBytes = new Uint8Array(existing);
  return existingBytes.every((byte, i) => byte === wanted[i]);
}

/** VAPID public keys travel as url-safe base64 without padding. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}
