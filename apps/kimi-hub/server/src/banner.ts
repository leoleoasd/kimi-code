/**
 * Startup-banner connect lines: paste-ready `remote connect` commands for the
 * TUI and the CLI, printed after the Origin/Token/Open lines.
 *
 * `<session-id>` stays a LITERAL placeholder — the hub cannot know the session
 * id at boot, and `kimi remote connect` requires `--session`, so the user
 * edits it in place after pasting. With `--dangerous-bypass-auth` the token
 * segment is dropped: connectors connect tokenless (the tunnel registry runs
 * with `trustAnyToken`).
 */

export interface ConnectBannerInput {
  /** Live hub origin, e.g. `http://127.0.0.1:58630`. */
  readonly origin: string;
  /** Omitted in `--dangerous-bypass-auth` mode: the connect lines go tokenless. */
  readonly token?: string;
}

/** The four connect lines: header, TUI form, separator, CLI form. */
export function connectBannerLines(input: ConnectBannerInput): string[] {
  const credentials = input.token !== undefined ? ` --token ${input.token}` : '';
  const session = ' --session <session-id>';
  return [
    'Connect a terminal:',
    `  /remote connect ${input.origin}${credentials}${session}`,
    '…or from the CLI:',
    `  kimi remote connect ${input.origin}${credentials}${session}`,
  ];
}
