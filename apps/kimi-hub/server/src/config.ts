/**
 * Hub config resolution: CLI flags over env vars over defaults.
 *
 * The single hub credential comes from `--token` or `KIMI_HUB_TOKEN`; when
 * neither is set a random 24-hex-char token is generated at boot and printed
 * in the startup banner (never logged elsewhere).
 *
 * `--dangerous-bypass-auth` (mirrors `kimi web`) runs the server with
 * `disableAuth: true`; the token is still resolved for the banner, and the
 * tunnel registry is created with `trustAnyToken` so agents can also connect
 * tokenless (the banner's connect lines drop the `--token` segment).
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLoopbackBind } from '#/hostnames';

export const HUB_DEFAULT_HOST = '127.0.0.1';
export const HUB_DEFAULT_PORT = 58630;
export const HUB_DEFAULT_LOG_LEVEL = 'info';

/** Raw CLI-ish inputs (`node:util` `parseArgs` values shape). */
export interface HubCliArgs {
  readonly host?: string;
  readonly port?: string | number;
  readonly token?: string;
  readonly webDist?: string;
  readonly logLevel?: string;
  /** `--dangerous-bypass-auth` (boolean flag, mirrors `kimi web`). */
  readonly dangerousBypassAuth?: boolean;
}

export interface HubConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** True when the token was generated at boot (banner calls it out). */
  readonly tokenGenerated: boolean;
  readonly webDist: string;
  /**
   * True when `--web-dist` was passed explicitly. An explicit dir forces
   * filesystem web-asset serving even in a SEA binary (see
   * `routes/webAssets.ts`); without it a SEA serves its embedded bundle.
   */
  readonly webDistFromCli: boolean;
  readonly logLevel: string;
  /** `--dangerous-bypass-auth`: every auth surface skips its credential check. */
  readonly disableAuth: boolean;
  /** Human-facing warnings for the startup banner (e.g. non-loopback bind). */
  readonly warnings: readonly string[];
}

/**
 * Default web UI bundle: `apps/kimi-hub/web/dist`. This module sits exactly
 * one level below the package root in both layouts (`src/config.ts` under
 * tsx/vitest, bundled into `dist/*.mjs` for `node dist/main.mjs`), so the
 * relative URL resolves identically either way. In a SEA binary this path
 * does not exist — web assets come from the embedded blob then (see
 * `routes/webAssets.ts`), unless `--web-dist` overrides them.
 */
export function defaultWebDist(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

export function resolveHubConfig(input: {
  cliArgs: HubCliArgs;
  env: NodeJS.ProcessEnv;
}): HubConfig {
  const { cliArgs, env } = input;

  const host = nonEmpty(cliArgs.host) ?? HUB_DEFAULT_HOST;
  const port = parsePort(cliArgs.port);

  const givenToken = nonEmpty(cliArgs.token) ?? nonEmpty(env['KIMI_HUB_TOKEN']);
  const tokenGenerated = givenToken === undefined;
  const token = givenToken ?? randomBytes(12).toString('hex'); // 24 hex chars

  const cliWebDist = nonEmpty(cliArgs.webDist);
  const webDist = cliWebDist !== undefined ? resolve(cliWebDist) : defaultWebDist();
  const webDistFromCli = cliWebDist !== undefined;
  const logLevel = nonEmpty(cliArgs.logLevel) ?? HUB_DEFAULT_LOG_LEVEL;
  const disableAuth = cliArgs.dangerousBypassAuth === true;

  const warnings: string[] = [];
  if (!isLoopbackBind(host)) {
    // MVP is single-tenant: one bearer token, no TLS machinery of its own.
    warnings.push(
      `--host ${host} is not loopback; kimi-hub is single-tenant bearer auth with no built-in TLS — put it behind your own TLS proxy for real deployments`,
    );
  }
  if (disableAuth) {
    // The banner's loud line; composed here so it is printed exactly once,
    // whether or not the bind is loopback.
    warnings.push(
      '--dangerous-bypass-auth: auth DISABLED — anyone who can reach the port has full control of the hub and every connected agent',
    );
  }

  return { host, port, token, tokenGenerated, webDist, webDistFromCli, logLevel, disableAuth, warnings };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined) {
    return HUB_DEFAULT_PORT;
  }
  const port = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`invalid --port: ${String(value)}`);
  }
  return port;
}
