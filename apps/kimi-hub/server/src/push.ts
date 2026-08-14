/**
 * Web Push fanout — the closed-tab delivery half of the hub's notification
 * chain. The VAPID keypair and the browser push subscriptions are generated
 * / recorded once and persisted to `<hubDataDir>/push/` so a hub restart
 * keeps device registrations. Subscriptions prune themselves on a 404/410
 * push answer (the browser revoked them) and on a 400 `VapidPkHashMismatch`
 * (the subscription is bound to a retired VAPID key — Apple rejects every
 * send for it). Everything else is best-effort and logged: one failed
 * endpoint never blocks the others.
 *
 * VAPID subject must be a mailto: / https: contact on a REAL domain —
 * `*.local` is accepted by FCM but rejected by APNs (403 BadJwtToken).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import webpush, { type PushSubscription } from 'web-push';

export interface PushModule {
  readonly publicKey: string;
  upsert(subscription: PushSubscription): number;
  remove(endpoint: string): number;
  list(): readonly PushSubscription[];
  fanout(payload: { notificationId: string; sessionId: string; title: string; body: string; agentName?: string }): Promise<number>;
  /** Await the queued best-effort writes (shutdown + tests). */
  flush(): Promise<void>;
}

/** Minimal logger shape — satisfied by fastify's `app.log`. */
export interface PushLogger {
  warn(obj: unknown, msg?: string): void;
}

export const VAPID_SUBJECT = 'https://kimi-hub.leoleoasd.me';

export async function openPushModule(dataDir: string, logger?: PushLogger): Promise<PushModule> {
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
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);

  let subscriptions: PushSubscription[];
  try {
    const raw = JSON.parse(await readFile(subsPath, 'utf8')) as unknown;
    subscriptions = Array.isArray(raw) ? (raw as PushSubscription[]) : [];
  } catch {
    subscriptions = [];
  }
  // Serialize writes: callers fire-and-forget (`void persist()`), and two
  // concurrent writeFile streams into the same path can produce one
  // corrupted JSON document. Each write is tmp-file + atomic rename so a
  // concurrent reader never catches the truncate-then-write gap. Errors are
  // swallowed — persistence is best-effort, the in-memory list is
  // authoritative until restart.
  let persistChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    persistChain = persistChain
      .then(async () => {
        const tmp = `${subsPath}.tmp`;
        await writeFile(tmp, JSON.stringify(subscriptions), 'utf8');
        await rename(tmp, subsPath);
      })
      .catch(() => undefined);
    return persistChain;
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
    flush() {
      return persistChain;
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
            const err = error as { statusCode?: number; body?: string };
            const status = err.statusCode;
            const reason = failureReason(err.body);
            // Permanently dead subscriptions: the browser revoked the endpoint
            // (404/410), or it is bound to a retired VAPID key (400
            // VapidPkHashMismatch — clients re-register on their next visit).
            const dead = status === 404 || status === 410 || (status === 400 && reason === 'VapidPkHashMismatch');
            if (dead) {
              subscriptions = subscriptions.filter((s) => s.endpoint !== subscription.endpoint);
              void persist();
            }
            logger?.warn({ endpointHost: endpointHost(subscription.endpoint), statusCode: status, reason, pruned: dead }, 'web push delivery failed');
          }
        }),
      );
      return sent;
    },
  };
}


/** `reason` from a push-service JSON error envelope (Apple answers JSON). */
function failureReason(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

function endpointHost(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}
