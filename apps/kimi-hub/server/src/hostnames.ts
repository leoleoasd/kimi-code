/**
 * Host-header allowlist — trimmed port of kap-server's
 * `packages/kap-server/src/middleware/hostnames.ts` (the DNS-rebinding
 * defence), with the env var renamed to `KIMI_HUB_ALLOWED_HOSTS`.
 *
 * Default-allow set: `localhost` / `*.localhost`, loopback literals, any
 * literal IP, the host the hub bound to, plus caller-supplied extras (a
 * leading `.` matches the bare domain and any subdomain).
 */

import net from 'node:net';

export interface HostAllowlistOptions {
  /** The host the hub bound to; always allowed (port stripped both sides). */
  readonly boundHost?: string;
  /** Extra allowed hosts / domain-suffix patterns (from `KIMI_HUB_ALLOWED_HOSTS`). */
  readonly extra?: readonly string[];
}

/** Parse `KIMI_HUB_ALLOWED_HOSTS`: comma-separated, trimmed, empties dropped. */
export function parseAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['KIMI_HUB_ALLOWED_HOSTS'];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Strip a trailing `:port` from a `Host` value and lowercase it. Bracketed
 * IPv6 with a port (`[::1]:80` → `[::1]`) and bare IPv6 (no unambiguous port)
 * are handled.
 */
export function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return (end === -1 ? host : host.slice(0, end + 1)).toLowerCase();
  }
  const firstColon = host.indexOf(':');
  if (firstColon === -1) {
    return host.toLowerCase();
  }
  const lastColon = host.lastIndexOf(':');
  if (firstColon === lastColon) {
    const after = host.slice(lastColon + 1);
    if (after.length > 0 && /^\d+$/.test(after)) {
      return host.slice(0, lastColon).toLowerCase();
    }
  }
  // Multiple colons (bare IPv6) or a non-digit suffix — no port to strip.
  return host.toLowerCase();
}

/** `true` for loopback-only bind addresses (used to warn on public binds). */
export function isLoopbackBind(host: string): boolean {
  const h = stripPort(host);
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}

/**
 * Decide whether a `Host` value is allowed. Missing/empty `Host` is rejected
 * (HTTP/1.1 requires it; WS upgrades carry it too).
 */
export function isAllowedHost(host: string | undefined, opts: HostAllowlistOptions): boolean {
  if (host === undefined || host.length === 0) {
    return false;
  }
  const h = stripPort(host);

  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') {
    return true;
  }
  if (h.endsWith('.localhost')) {
    return true;
  }
  if (net.isIP(h) !== 0) {
    return true;
  }
  if (opts.boundHost !== undefined && h === stripPort(opts.boundHost)) {
    return true;
  }
  if (opts.extra !== undefined) {
    for (const entry of opts.extra) {
      if (entry.startsWith('.')) {
        const base = entry.slice(1);
        if (h === base || h.endsWith(entry)) {
          return true;
        }
      } else if (h === entry) {
        return true;
      }
    }
  }
  return false;
}

export function formatHostErrorMessage(host: string | undefined): string {
  const normalized = host === undefined || host.length === 0 ? '<missing>' : stripPort(host);
  return `Invalid Host header: ${normalized}; allow this host with KIMI_HUB_ALLOWED_HOSTS=${normalized}.`;
}
