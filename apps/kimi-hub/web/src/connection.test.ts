/**
 * Token bootstrap + hub-origin resolution — pure logic, no DOM needed.
 */

import { describe, expect, it } from 'vitest';

import {
  extractTokenFromLocation,
  persistTokenChoice,
  probeAuthlessHub,
  readTokenChoice,
  resetTokenChoice,
  resolveHubOrigin,
  type TokenChoiceStorage,
} from './connection';

describe('extractTokenFromLocation', () => {
  it('reads the token from the #token= fragment', () => {
    expect(extractTokenFromLocation('#token=abc123', '')).toBe('abc123');
  });

  it('reads the token from the ?token= query', () => {
    expect(extractTokenFromLocation('', '?token=q-1&x=2')).toBe('q-1');
  });

  it('prefers the fragment over the query', () => {
    expect(extractTokenFromLocation('#token=h', '?token=q')).toBe('h');
  });

  it('treats an empty token as absent', () => {
    expect(extractTokenFromLocation('#token=', '')).toBeNull();
    expect(extractTokenFromLocation('', '?token=')).toBeNull();
  });

  it('returns null when no token is present', () => {
    expect(extractTokenFromLocation('', '')).toBeNull();
    expect(extractTokenFromLocation('#foo=1', '?bar=2')).toBeNull();
  });

  it('keeps a url-encoded token intact', () => {
    expect(extractTokenFromLocation('', '?token=a%2Bb')).toBe('a+b');
  });
});

describe('resolveHubOrigin', () => {
  it('falls back to the deployment origin when unset or blank', () => {
    expect(resolveHubOrigin(undefined, 'http://h:1')).toBe('http://h:1');
    expect(resolveHubOrigin(null, 'http://h:1')).toBe('http://h:1');
    expect(resolveHubOrigin('   ', 'http://h:1')).toBe('http://h:1');
  });

  it('trims whitespace and trailing slashes', () => {
    expect(resolveHubOrigin(' https://hub.internal/ ', 'http://h:1')).toBe('https://hub.internal');
    expect(resolveHubOrigin('http://h:1///', 'http://x')).toBe('http://h:1');
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => resolveHubOrigin('ftp://h', 'http://h:1')).toThrow(/http/);
    expect(() => resolveHubOrigin('hub.internal', 'http://h:1')).toThrow(/http/);
  });
});

/** In-memory stand-in for sessionStorage (the helpers' only DOM dependency). */
function memoryStorage(): TokenChoiceStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('token choice persistence (the "" authless sentinel)', () => {
  it('distinguishes "not stored" (null) from the stored sentinel ("")', () => {
    const storage = memoryStorage();
    expect(readTokenChoice(storage)).toBeNull(); // → the token-entry form

    persistTokenChoice(storage, '');
    expect(readTokenChoice(storage)).toBe(''); // → connected, no credential
  });

  it('persists a real token unchanged', () => {
    const storage = memoryStorage();
    persistTokenChoice(storage, 'tok-1');
    expect(readTokenChoice(storage)).toBe('tok-1');
  });

  it('reset removes the sentinel, landing back on the token-entry state (no dead-loop)', () => {
    const storage = memoryStorage();
    persistTokenChoice(storage, '');
    expect(readTokenChoice(storage)).toBe('');

    // The 401/disconnect reset must NOT leave the sentinel behind — otherwise
    // the provider would re-enter authless mode against a hub that clearly
    // requires a token and loop the failing connect forever.
    resetTokenChoice(storage);
    expect(readTokenChoice(storage)).toBeNull();
  });
});

describe('probeAuthlessHub', () => {
  const fakeResponse = (status: number): Response => ({ status }) as Response;

  it('returns true when the hub answers the bare probe with 200 (authless)', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      if (typeof input === 'string') seen.push(input);
      return fakeResponse(200);
    };
    await expect(probeAuthlessHub('http://hub:58630', fetchImpl)).resolves.toBe(true);
    expect(seen).toEqual(['http://hub:58630/hub/api/agents']);
  });

  it('returns false when the hub gates with 401', async () => {
    const fetchImpl: typeof fetch = async () => fakeResponse(401);
    await expect(probeAuthlessHub('http://hub:58630', fetchImpl)).resolves.toBe(false);
  });

  it('returns false on network failure instead of throwing', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connection refused');
    };
    await expect(probeAuthlessHub('http://hub:58630', fetchImpl)).resolves.toBe(false);
  });
});
