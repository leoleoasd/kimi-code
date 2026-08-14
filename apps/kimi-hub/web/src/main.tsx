import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ConnectionProvider } from './connection';
import './index.css';

// The asset-shell service worker: asset caching only, every /api and hub data
// frame bypasses the caches — dead-wrong on this one day and the hub's data
// could go stale. Registered in production builds only. A newly activated SW
// (deploy with different assets) bounces every controlled page once, so an
// installed PWA never sits on a stale bundle until someone force-refreshes.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Only an UPGRADE bounce: a page that loaded uncontrolled (first-ever
  // install) must not reload on its own activation.
  const hadController = navigator.serviceWorker.controller !== null;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false },
  },
});

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider>
        <App />
      </ConnectionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
