/**
 * Web Push fanout — the closed-tab delivery half of the hub's notification
 * chain. The VAPID keypair and the browser push subscriptions are generated
 * / recorded once and persisted to `<hubDataDir>/push/` so a hub restart
 * keeps device registrations. Subscriptions prune themselves on a 404/410
 * push answer (the browser revoked them), everything else is best-effort:
 * one failed endpoint never blocks the others.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import webpush, { type PushSubscription } from 'web-push';

export interface PushModule {
  readonly publicKey: string;
  upsert(subscription: PushSubscription): number;
  remove(endpoint: string): number;
  list(): readonly PushSubscription[];
  fanout(payload: { notificationId: string; sessionId: string; title: string; body: string; agentName?: string }): Promise<number>;
}

export async function openPushModule(dataDir: string): Promise<PushModule> {
  await mkdir(dataDir, { recursive: true });
  const keysPath = join(dataDir, 'push-vapid.json');
  const subsPath = join(dataDir, 'push-subscriptions.json');

  let keys: { publicKey: string; privateKey: string };
  try {
    keys = JSON.parse(await readFile(keysPath, 'utf8')) as typeof keys;
  } catch {
    keys = webpush.generateVAPIDKeys();
    await writeFile(keysPath, JSON.stringify(keys), 'utf8');
  }
  webpush.setVapidDetails('mailto:notify@kimi-hub.local', keys.publicKey, keys.privateKey);

  let subscriptions: PushSubscription[];
  try {
    const raw = JSON.parse(await readFile(subsPath, 'utf8')) as unknown;
    subscriptions = Array.isArray(raw) ? (raw as PushSubscription[]) : [];
  } catch {
    subscriptions = [];
  }
  const persist = async (): Promise<void> => {
    await writeFile(subsPath, JSON.stringify(subscriptions), 'utf8');
  };

  return {
    publicKey: keys.publicKey,
    upsert(subscription) {
      const idx = subscriptions.findIndex((s) => s.endpoint === subscription.endpoint);
      if (idx >= 0) subscriptions[idx] = subscription;
      else subscriptions.push(subscription);
      void persist();
      return subscriptions.length;
    },
    remove(endpoint) {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
      if (subscriptions.length !== before) void persist();
      return subscriptions.length;
    },
    list() {
      return subscriptions;
    },
    async fanout(payload) {
      const data = JSON.stringify({
        notificationId: payload.notificationId,
        sessionId: payload.sessionId,
        title: payload.title,
        body: payload.body,
        agentName: payload.agentName,
      });
      let sent = 0;
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(subscription, data, {
              // `tag` rides in the payload (the SW passes it to
              // showNotification): identical frames replace, not stack.
              TTL: 3600,
            });
            sent += 1;
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              subscriptions = subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
              void persist();
            }
          }
        }),
      );
      return sent;
    },
  };
}
