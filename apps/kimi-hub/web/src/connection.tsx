/**
 * Hub connection context — owns the hub origin + bearer token the whole app
 * codes against.
 *
 * Bootstrap (mirrors the production web UI convention):
 *   1. `#token=` fragment or `?token=` query → stored in sessionStorage
 *      (`kimi-hub.token`), then stripped from the URL bar via
 *      `history.replaceState` so the token never lingers in a shareable URL;
 *   2. the manual connect form (token required, hub origin optional — default
 *      `window.location.origin`). The origin override persists in
 *      localStorage (`kimi-hub.origin`) because it is a deployment fact, not
 *      a credential;
 *   3. the authless continue: when the hub runs with
 *      `--dangerous-bypass-auth`, the EMPTY STRING is stored as the sentinel
 *      in sessionStorage — the provider treats it as "connected, no
 *      credential" and every transport omits the `Authorization` header /
 *      `kimi-hub.bearer.*` subprotocol for it (never `Bearer ` empty). The
 *      sentinel must never collapse into "absent": `null` (nothing stored) is
 *      the only value that shows the token-entry form.
 *
 * Everything the app talks to sits on the hub origin: `GET /hub/api/agents`
 * for the roster, and `${hubOrigin}/agents/{agentId}` as the base URL for the
 * unchanged kap-server protocol of one agent — the UI never goes cross-origin
 * to an agent. `disconnect` clears the stored token and lands back here.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export const TOKEN_STORAGE_KEY = 'kimi-hub.token';
export const ORIGIN_STORAGE_KEY = 'kimi-hub.origin';

/**
 * Pull the bootstrap token out of a URL fragment (`#token=…`) or query
 * (`?token=…`). The fragment wins: it is never sent to the server, so it is
 * the channel the CLI prints for humans. Empty values count as absent.
 */
export function extractTokenFromLocation(hash: string, search: string): string | null {
  if (hash.startsWith('#')) {
    const fromHash = new URLSearchParams(hash.slice(1)).get('token');
    if (fromHash !== null && fromHash !== '') return fromHash;
  }
  const fromQuery = new URLSearchParams(search).get('token');
  if (fromQuery !== null && fromQuery !== '') return fromQuery;
  return null;
}

/**
 * Resolve the configured hub origin override to an absolute base: trimmed,
 * trailing slashes stripped, empty/absent falls back to the deployment
 * origin. Must be `http(s)://` — the same value later derives the WS URL.
 */
export function resolveHubOrigin(raw: string | null | undefined, fallbackOrigin: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') return fallbackOrigin;
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(`hub origin must be an http(s) URL, got: ${trimmed}`);
  }
  return trimmed;
}

function readStoredOrigin(): string {
  try {
    return localStorage.getItem(ORIGIN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Storage-facing subset used by the token-choice helpers (injectable for tests). */
export type TokenChoiceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The stored token choice: `null` = nothing stored (back to the token-entry
 * form), `''` = the AUTHLESS sentinel (`--dangerous-bypass-auth` continue),
 * anything else = a bearer token.
 */
export function readTokenChoice(storage: TokenChoiceStorage): string | null {
  try {
    return storage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist a token choice; `''` stores the authless sentinel verbatim. */
export function persistTokenChoice(storage: TokenChoiceStorage, token: string): void {
  try {
    storage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage unavailable (private mode) — keep the in-memory session only.
  }
}

/**
 * Clear the stored choice — the next state is the token-entry form. Called on
 * disconnect AND as the reset after a failed connect: clearing back to `null`
 * (never re-entering the sentinel) is what keeps that reset from dead-looping
 * into authless mode when the hub actually requires a token.
 */
export function resetTokenChoice(storage: TokenChoiceStorage): void {
  try {
    storage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readInitialToken(): string | null {
  try {
    const fromUrl = extractTokenFromLocation(window.location.hash, window.location.search);
    if (fromUrl !== null) {
      persistTokenChoice(sessionStorage, fromUrl);
      // The token must not linger in the URL bar (bookmarks / shares).
      window.history.replaceState(null, '', window.location.pathname);
      return fromUrl;
    }
    return readTokenChoice(sessionStorage);
  } catch {
    return null;
  }
}

export interface HubConnection {
  /** Absolute hub origin (`http(s)://host:port`, no trailing slash). */
  readonly hubOrigin: string;
  /**
   * The bearer token transports present; `''` is the authless sentinel —
   * transports MUST omit the `Authorization` header / `kimi-hub.bearer.*`
   * subprotocol for it rather than sending an empty credential.
   */
  readonly token: string;
  readonly connect: (token: string, origin: string) => void;
  readonly disconnect: () => void;
}

const ConnectionContext = createContext<HubConnection | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  // `null` = not connected (the token-entry form shows); `''` = the authless
  // sentinel; anything else = the bearer token.
  const [token, setToken] = useState<string | null>(readInitialToken);
  const [hubOrigin, setHubOrigin] = useState(() => {
    try {
      return resolveHubOrigin(readStoredOrigin(), window.location.origin);
    } catch {
      // Corrupt stored override — fall back to the deployment origin.
      return window.location.origin;
    }
  });
  const [originError, setOriginError] = useState<string | null>(null);

  /** Shared tail of both connect paths: validate the origin, persist, apply. */
  const applyConnection = useCallback((nextToken: string, nextOrigin: string) => {
    let resolved: string;
    try {
      resolved = resolveHubOrigin(nextOrigin, window.location.origin);
    } catch (error) {
      setOriginError(error instanceof Error ? error.message : String(error));
      return;
    }
    setOriginError(null);
    persistTokenChoice(sessionStorage, nextToken);
    try {
      if (nextOrigin.trim() === '') localStorage.removeItem(ORIGIN_STORAGE_KEY);
      else localStorage.setItem(ORIGIN_STORAGE_KEY, nextOrigin.trim());
    } catch {
      // Storage unavailable (private mode) — keep the in-memory session only.
    }
    setHubOrigin(resolved);
    setToken(nextToken);
  }, []);

  const connect = useCallback(
    (nextToken: string, nextOrigin: string) => {
      const trimmedToken = nextToken.trim();
      // The form stays token-required; authless goes through onAuthless.
      if (trimmedToken === '') return;
      applyConnection(trimmedToken, nextOrigin);
    },
    [applyConnection],
  );

  /** Store the `''` sentinel: connect with credentials omitted on the wire. */
  const continueAuthless = useCallback(
    (nextOrigin: string) => {
      applyConnection('', nextOrigin);
    },
    [applyConnection],
  );

  const disconnect = useCallback(() => {
    resetTokenChoice(sessionStorage);
    setToken(null);
  }, []);

  const value = useMemo<HubConnection | null>(() => {
    if (token === null) return null;
    return { hubOrigin, token, connect, disconnect };
  }, [token, hubOrigin, connect, disconnect]);

  return (
    <ConnectionContext.Provider value={value}>
      {value !== null ? (
        children
      ) : (
        <ConnectScreen onConnect={connect} onAuthless={continueAuthless} error={originError} />
      )}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): HubConnection {
  const value = useContext(ConnectionContext);
  if (value === null) throw new Error('useConnection used before connecting');
  return value;
}

function ConnectScreen({
  onConnect,
  onAuthless,
  error,
}: {
  onConnect: (token: string, origin: string) => void;
  onAuthless: (origin: string) => void;
  error: string | null;
}) {
  const [token, setToken] = useState('');
  const [origin, setOrigin] = useState(readStoredOrigin);
  return (
    <div className="flex h-screen items-center justify-center">
      <form
        className="w-[420px] rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect(token, origin);
        }}
      >
        <h1 className="mb-1 text-lg font-semibold text-neutral-100">Kimi Hub</h1>
        <p className="mb-5 text-xs leading-relaxed text-neutral-500">
          One page for the kimi-code sessions running on every machine connected to your hub. Paste
          the hub token — it comes from the hub startup banner (
          <code className="text-neutral-400">--token</code> or generated) — or open an URL carrying{' '}
          <code className="text-neutral-400">#token=…</code> to skip this screen. Blank is valid
          only when the hub runs with{' '}
          <code className="text-neutral-400">--dangerous-bypass-auth</code>.
        </p>
        <label className="mb-1 block text-xs text-neutral-400">Hub token</label>
        <input
          autoFocus
          className="mb-4 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-600"
          placeholder="hub bearer token"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
          }}
        />
        <label className="mb-1 block text-xs text-neutral-400">Hub origin (optional)</label>
        <input
          className="mb-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-600"
          placeholder={`${window.location.origin} (default)`}
          value={origin}
          onChange={(e) => {
            setOrigin(e.target.value);
          }}
        />
        {error !== null ? (
          <div className="mb-4 rounded bg-red-950/50 px-2 py-1.5 text-[11px] text-red-400">
            {error}
          </div>
        ) : (
          <div className="mb-4" />
        )}
        <button
          type="submit"
          disabled={token.trim() === ''}
          className="w-full rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          Connect
        </button>
        <button
          type="button"
          className="mt-3 w-full text-center text-[11px] text-neutral-500 underline decoration-dotted underline-offset-2 hover:text-neutral-300"
          onClick={() => {
            onAuthless(origin);
          }}
        >
          the hub runs without auth (dangerous-bypass) → continue
        </button>
      </form>
    </div>
  );
}
