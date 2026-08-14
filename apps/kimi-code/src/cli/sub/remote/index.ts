/**
 * `kimi remote` — remote control via a kimi hub.
 *
 * `kimi remote connect <hub-url>` attaches this machine to a running hub: it
 * starts the local loopback server in-process (like `kimi web`, but API-only —
 * no web UI assets) and dials out over the reverse tunnel, so the hub's web UI
 * can list and control this machine's sessions. The process stays attached to
 * the terminal until Ctrl+C.
 */

import type { Command } from 'commander';

import { parseServerOptions, DEFAULT_SERVER_PORT } from '../web/shared';
import { runRemoteConnect } from './run';
import { DEFAULT_LOCAL_HUB_URL, HUB_TOKEN_ENV } from './shared';

interface RemoteConnectCliOptions {
  token?: string;
  name?: string;
  port?: string;
  session: string;
}

export function registerRemoteCommand(program: Command): void {
  const remote = program
    .command('remote')
    .description('Remote control: connect this machine to a running kimi hub.');

  remote
    .command('connect')
    .argument(
      '[hub-url]',
      `Hub origin (http(s):// or ws(s)://); defaults to the local hub (${DEFAULT_LOCAL_HUB_URL}).`,
    )
    .description('Start the local loopback server and dial out to a running kimi hub.')
    .requiredOption(
      '--session <id>',
      'Session id this connection exposes; the hub refuses access to anything else.',
    )
    .option('--token <token>', `Hub bearer token (defaults to ${HUB_TOKEN_ENV}).`)
    .option('--name <name>', 'Agent name shown in the hub UI (defaults to the hostname).')
    .option(
      '--port <port>',
      `Local server port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .action(async (hubUrl: string | undefined, opts: RemoteConnectCliOptions) => {
      try {
        await runRemoteConnect({
          hubUrl: hubUrl ?? DEFAULT_LOCAL_HUB_URL,
          token: opts.token,
          name: opts.name,
          sessionId: opts.session,
          serverOptions: parseServerOptions({ port: opts.port }),
        });
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
