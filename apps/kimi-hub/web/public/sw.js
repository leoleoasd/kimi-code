/*
 * Kimi Hub service worker — an asset-shell cache, nothing more:
 *  - cache-first for fingerprinted build outputs (/assets/*) and /icons/*
 *  - network-first for the document and everything else, caching successes so
 *    a reopened standalone launch still shows a shell when the hub is briefly
 *    unreachable (NOT for /api, /hub, /agents data: those always go to the
 *    network — the app surfaces its own offline error instead of stale JSON).
 */

const SHELL_CACHE = 'kimi-hub-shell-v3';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

/*
 * Web Push: the hub fans a `notify` frame out to `sendNotification` for every
 * registered subscription (server/src/push.ts) — this is the closed-tab /
 * background-session wake path. Payload carries the frame.
 *
 * Channel coordination: the SAME notificationId also arrives over the roster
 * stream and is rendered by the page (hub/notifications.ts showHubNotification)
 * whenever any hub window is open. tag-replacement was expected to collapse
 * the two renders into one but does not hold in practice (macOS Chrome and
 * installed iOS PWAs both displayed pairs), so the rendezvous is explicit
 * instead: an OPEN window proves the page channel is live, and the push-
 * handler side stays silent; suspended/closed pages own no WindowClient, so
 * the wake path still fires for genuinely unattended devices.
 */
self.addEventListener('push', (event) => {
  if (event.data === null) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = undefined;
  }
  if (
    payload === undefined ||
    typeof payload.notificationId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.title !== 'string' ||
    typeof payload.body !== 'string'
  ) {
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.length > 0) return;
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: `kimi-hub/${payload.notificationId}`,
        data: {
          type: 'notification-click',
          agentName: payload.agentName ?? '',
          sessionId: payload.sessionId,
        },
      });
    })(),
  );
});

/*
 * Notification click-through: an agent's NotifyUser notification carries its
 * (agentName, sessionId); focus an open hub window and hand it the selection,
 * or open one aimed at it. The page listens on `navigator.serviceWorker`'s
 * 'message' (see hub/notifications.ts).
 */
self.addEventListener('notificationclick', (event) => {
  const data = event.notification && event.notification.data;
  const selection =
    data && data.type === 'notification-click'
      ? { agentName: data.agentName, sessionId: data.sessionId }
      : undefined;
  event.notification.close();
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) {
        if (selection !== undefined && 'postMessage' in client) {
          client.postMessage({ type: 'notification-click', ...selection });
        }
        if ('focus' in client) {
          await client.focus();
          return;
        }
      }
      const url =
        selection === undefined
          ? '/'
          : `/?focusAgentName=${encodeURIComponent(selection.agentName)}&focusSessionId=${encodeURIComponent(selection.sessionId)}`;
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hub/api') || url.pathname.startsWith('/agents/') || url.pathname.startsWith('/internal/')) {
    return;
  }

  const isStatic =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.ico';

  if (isStatic) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached !== undefined) return cached;
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = await cache.match('/');
          if (cached !== undefined) return cached;
          throw new Error('network unavailable and no cached shell');
        }
      })(),
    );
  }
});
