/**
 * CLI entry: `node dist/main.mjs [--host H] [--port P] [--token T]
 * [--web-dist DIR] [--log-level L]`.
 *
 * The banner is the ONLY place the token is printed (plain stdout, never the
 * pino logger): browsers open `Open: <origin>#token=<token>`, the web UI reads
 * the fragment and moves it to sessionStorage.
 */

import { parseArgs } from 'node:util';

import { connectBannerLines } from '#/banner';
import { startHub, type RunningHub } from '#/start';

const USAGE = `Usage: kimi-hub-server [--host 127.0.0.1] [--port 58630] [--token TOKEN]
                       [--web-dist ../web/dist] [--log-level info]
                       [--dangerous-bypass-auth]

Options:
  --host                    Bind address (default 127.0.0.1)
  --port                    Port (default 58630; port+1 retry when busy)
  --token                   Hub bearer token (or KIMI_HUB_TOKEN; generated when absent)
  --web-dist                Built hub web UI directory
  --log-level               pino level (default info; "silent" disables logging)
  --dangerous-bypass-auth   Disable the bearer-token gate on every HTTP/WS
                            surface, including the tunnel hello handshake
                            (DANGEROUS)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      token: { type: 'string' },
      'web-dist': { type: 'string' },
      'log-level': { type: 'string' },
      'dangerous-bypass-auth': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const hub = await startHub({
    host: values.host,
    port: values.port,
    token: values.token,
    webDist: values['web-dist'],
    logLevel: values['log-level'],
    dangerousBypassAuth: values['dangerous-bypass-auth'],
  });
  printBanner(hub);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal} — shutting down\n`);
    void hub
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function printBanner(hub: RunningHub): void {
  const lines: string[] = [];
  for (const warning of hub.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push('kimi-hub listening');
  lines.push(`  Origin: ${hub.origin}`);
  if (hub.tokenGenerated) {
    lines.push(`  Token:  ${hub.token} (generated at boot — pass --token or KIMI_HUB_TOKEN to pin it)`);
  }
  lines.push(`  Open:   ${hub.origin}#token=${hub.token}`);
  if (hub.dangerousBypassAuth) {
    lines.push('  Auth:   DISABLED on all surfaces; agent connectors may connect tokenless at /internal/tunnel');
  }
  lines.push(...connectBannerLines({ origin: hub.origin, token: hub.dangerousBypassAuth ? undefined : hub.token }));
  process.stdout.write(`${lines.join('\n')}\n`);
}

// No top-level await: the native SEA bundle (tsdown.dist-native.config.ts)
// emits CommonJS, where TLA cannot be represented — `.catch` keeps the dev
// (tsx) and dist (`node dist/main.mjs`) entries byte-identical in behavior.
// oxlint-disable-next-line unicorn/prefer-top-level-await -- see above: TLA is impossible in the Cjs SEA bundle
void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`kimi-hub-server failed to start: ${message}\n`);
  process.exit(1);
});
