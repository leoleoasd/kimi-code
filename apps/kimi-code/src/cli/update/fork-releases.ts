/**
 * Fork release channel: version checks against the fork's GitHub Releases.
 *
 * Each fork release publishes a `manifest.json` sharing the CDN rollout-
 * manifest shape (plus a `platforms` map the staged updater consumes, see
 * `native-manifest.ts`). GitHub's `releases/latest/download/` redirect makes
 * the newest non-prerelease release's manifest reachable at a stable URL, so
 * checks need no API calls (and no rate limits). A fork manifest carries an
 * empty rollout array — fork releases are fully rolled out on publish.
 */

import { KIMI_BUILD_INFO } from '#/cli/build-info';
import { KIMI_CODE_FORK_LATEST_MANIFEST_URL } from '#/constant/app';

import { UpdateManifestSchema, type FetchLatestResult } from './cdn';

const FORK_FETCH_TIMEOUT_MS = 3_000;

export function isForkChannel(): boolean {
  return KIMI_BUILD_INFO.channel === 'fork';
}

/**
 * Fetch the fork's latest release manifest. **Throws** on any failure
 * (network error, non-2xx, malformed body) — callers must catch, exactly like
 * `fetchLatestFromCdn`.
 */
export async function fetchLatestFromForkReleases(
  fetchImpl: typeof fetch = fetch,
): Promise<FetchLatestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FORK_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(KIMI_CODE_FORK_LATEST_MANIFEST_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`fork releases manifest returned HTTP ${response.status}`);
    }
    const manifest = UpdateManifestSchema.parse(JSON.parse(await response.text()));
    return { latest: manifest.version, manifest };
  } finally {
    clearTimeout(timeout);
  }
}
