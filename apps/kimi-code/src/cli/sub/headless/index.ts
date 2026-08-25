/**
 * `kimi headless` — start an agent in the background, driven only from the
 * kimi hub's web UI.
 *
 * By default the command respawns itself detached (stdout/stderr under
 * `~/.kimi-code/logs/`) and returns immediately — the agent process keeps
 * running after the terminal closes. `--foreground` keeps it attached
 * (Ctrl+C stops it). The agent creates one fresh session for the current
 * working directory (`--session <id>` exposes an existing one instead),
 * starts the local loopback server in-process, and dials OUT to the hub over
 * the reverse tunnel — exactly the wiring of `kimi remote connect`, minus the
 * terminal.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { loadTuiConfig } from '#/tui/config';
import { getDataDir } from '#/utils/paths';

import { parseServerOptions, DEFAULT_SERVER_PORT } from '../web/shared';
import { DEFAULT_LOCAL_HUB_URL, HUB_TOKEN_ENV, hubUiUrl, parseHubUrl, resolveHubToken } from '../remote/shared';
import { runHeadless } from './run';

const FOREGROUND_ENV = 'KIMI_HEADLESS_FOREGROUND';

interface HeadlessCliOptions {
  token?: string;
  name?: string;
  session?: string;
  title?: string;
  port?: string;
  foreground?: boolean;
}

export function registerHeadlessCommand(program: Command): void {
  program
    .command('headless')
    .argument(
      '[hub-url]',
      `Hub origin (http(s):// or ws(s)://); defaults to tui.toml [remote] hub_url, then the local hub (${DEFAULT_LOCAL_HUB_URL}).`,
    )
    .description('Run an agent in the background, controlled only from the kimi hub web UI.')
    .option('--token <token>', `Hub bearer token (defaults to ${HUB_TOKEN_ENV}).`)
    .option('--name <name>', 'Agent name shown in the hub UI (defaults to the hostname).')
    .option('--session <id>', 'Expose an existing session instead of creating a new one.')
    .option('--title <title>', 'Title for the newly created session.')
    .option(
      '--port <port>',
      `Local server port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .option('--foreground', 'Stay in the foreground instead of detaching.', false)
    .action(async (hubUrl: string | undefined, opts: HeadlessCliOptions) => {
      try {
        const config = await loadTuiConfig();
        const resolvedHubUrl = hubUrl ?? config.remote?.hubUrl ?? DEFAULT_LOCAL_HUB_URL;
        const resolvedName = opts.name ?? config.remote?.name ?? undefined;
        const resolvedToken = opts.token ?? config.remote?.token ?? undefined;
        if (opts.foreground !== true && process.env[FOREGROUND_ENV] !== '1') {
          spawnDetached({
            hubUrlArg: hubUrl,
            resolvedHubUrl,
            resolvedToken: resolveHubToken(resolvedToken) ?? '',
            token: opts.token,
            name: opts.name,
            sessionId: opts.session,
            title: opts.title,
            port: opts.port,
          });
          return;
        }
        await runHeadless({
          hubUrl: resolvedHubUrl,
          token: resolvedToken,
          name: resolvedName,
          sessionId: opts.session,
          title: opts.title,
          serverOptions: parseServerOptions({ port: opts.port }),
        });
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

function spawnDetached(hub: HubInvocation): void {
  const logDir = join(getDataDir(), 'logs');
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const logPath = join(logDir, `headless-${stamp}.log`);
  const fd = openSync(logPath, 'a');
  // Respawn with the parsed options, NOT process.argv: in the SEA the runtime
  // maps the raw exec argv onto node-style argv (`[exe, exe, ...userArgs]`),
  // so slicing it reproduces the binary path as the first user argument.
  const args: string[] = ['headless'];
  if (hub.hubUrlArg !== undefined) args.push(hub.hubUrlArg);
  if (hub.token !== undefined) args.push('--token', hub.token);
  if (hub.name !== undefined) args.push('--name', hub.name);
  if (hub.sessionId !== undefined) args.push('--session', hub.sessionId);
  if (hub.title !== undefined) args.push('--title', hub.title);
  if (hub.port !== undefined) args.push('--port', hub.port);
  // Plain `node main.js …` runs carry the script path as argv[1]; the SEA
  // reports the executable there instead, which the runtime re-adds itself.
  const script =
    process.argv[1] !== undefined && process.argv[1] !== process.execPath
      ? [process.argv[1]]
      : [];
  const child = spawn(process.execPath, [...process.execArgv, ...script, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, [FOREGROUND_ENV]: '1' },
    windowsHide: true,
  });
  child.unref();
  process.stdout.write(`kimi headless: detached as pid ${child.pid}\n`);
  process.stdout.write(`log: ${logPath}\n`);
  process.stdout.write(
    `hub UI: ${hubUiUrl(parseHubUrl(hub.resolvedHubUrl)).replace(/\/$/, '')}#token=${hub.resolvedToken}\n`,
  );
  process.stdout.write(`stop: kill ${child.pid}\n`);
}

interface HubInvocation {
  readonly hubUrlArg?: string;
  readonly resolvedHubUrl: string;
  readonly resolvedToken: string;
  readonly token?: string;
  readonly name?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly port?: string;
}
