import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev override for the hub server location (default: local hub on 58630).
const hubTarget = process.env['KIMI_HUB_URL'] ?? 'http://127.0.0.1:58630';

// The UI talks ONLY to the hub, same-origin: `/hub/*` (hub REST), `/agents/*`
// (per-agent tunneled proxy, WS included). `/internal/tunnel` is agent-only and
// deliberately not proxied from the browser dev server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/hub': { target: hubTarget, changeOrigin: true },
      '/agents': { target: hubTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
