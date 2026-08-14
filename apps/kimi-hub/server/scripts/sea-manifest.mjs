/**
 * Shared contract between the SEA build (`scripts/sea-assets.mjs`) and the
 * runtime embedded web asset layer (`src/routes/webAssets.ts`) — mirrors how
 * apps/kimi-code shares `scripts/native/manifest.mjs` with its src.
 *
 * The native build embeds every `web/dist` file as a SEA asset keyed
 * `web/dist/<posix path relative to the dist root>`, plus the manifest below
 * listing those relative paths.
 */

export const SEA_WEB_MANIFEST_VERSION = 1;

/** SEA asset key under which the embedded web manifest itself is stored. */
export const SEA_WEB_MANIFEST_KEY = 'web/assets-manifest.json';

/** SEA asset key for one embedded `web/dist` file (manifest key). */
export function seaWebAssetKey(relativePath) {
  return `web/dist/${relativePath}`;
}
