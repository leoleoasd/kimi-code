declare const __KIMI_CODE_VERSION__: string | undefined;
declare const __KIMI_CODE_CHANNEL__: string | undefined;
declare const __KIMI_CODE_COMMIT__: string | undefined;
declare const __KIMI_CODE_BUILD_TARGET__: string | undefined;
declare const __KIMI_CODE_FORK_VERSION__: string | undefined;

export interface KimiBuildInfo {
  readonly version?: string;
  readonly channel?: string;
  readonly commit?: string;
  readonly buildTarget?: string;
  /**
   * Fork release version (the fork tag without its `fork-v` prefix), stamped
   * only on binaries built by the fork release pipeline. Local `install:local`
   * builds leave it undefined so they never self-update past their own work.
   */
  readonly forkVersion?: string;
}

function optionalBuildString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const KIMI_BUILD_INFO: KimiBuildInfo = {
  version:
    typeof __KIMI_CODE_VERSION__ === 'string'
      ? optionalBuildString(__KIMI_CODE_VERSION__)
      : undefined,
  channel:
    typeof __KIMI_CODE_CHANNEL__ === 'string'
      ? optionalBuildString(__KIMI_CODE_CHANNEL__)
      : undefined,
  commit:
    typeof __KIMI_CODE_COMMIT__ === 'string'
      ? optionalBuildString(__KIMI_CODE_COMMIT__)
      : undefined,
  buildTarget:
    typeof __KIMI_CODE_BUILD_TARGET__ === 'string'
      ? optionalBuildString(__KIMI_CODE_BUILD_TARGET__)
      : undefined,
  forkVersion:
    typeof __KIMI_CODE_FORK_VERSION__ === 'string'
      ? optionalBuildString(__KIMI_CODE_FORK_VERSION__)
      : undefined,
};
