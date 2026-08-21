/**
 * Transcript rendering for `!` shell-command records.
 *
 * The engine records each `!cmd` as a user-role message whose ORIGIN is
 * `{ kind: 'shell_command', phase: 'input' | 'output', isError? }` and whose
 * text is an XML wrapper (`<bash-input>` / `<bash-stdout>` + `<bash-stderr>`)
 * with the inner payload XML-escaped. The transcript classification folds
 * that origin into `turn.origin = { kind: 'user', payload: <record origin> }`,
 * so the raw tagged text would otherwise end up in the ordinary user bubble.
 * Mirroring session-replay.ts in the TUI, we unwrap back to the terminal view:
 * `$ cmd` for input, plain stdout/stderr for output.
 */

export interface ShellCommandOrigin {
  phase: 'input' | 'output';
  isError: boolean;
}

/** Read the shell_command record origin back out of the transcript turn origin. */
export function shellCommandInfo(payload: unknown): ShellCommandOrigin | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const origin = payload as Record<string, unknown>;
  if (origin['kind'] !== 'shell_command') return undefined;
  const phase = origin['phase'];
  if (phase !== 'input' && phase !== 'output') return undefined;
  return { phase, isError: origin['isError'] === true };
}

function unescapeBashXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function extractBashTag(
  text: string,
  tag: 'bash-input' | 'bash-stdout' | 'bash-stderr',
): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1] === undefined ? undefined : unescapeBashXml(match[1]);
}

/** The command line of a `phase: 'input'` record; falls back to the raw text. */
export function parseShellInput(text: string): string {
  return (extractBashTag(text, 'bash-input') ?? text).trim();
}

export interface ShellOutput {
  stdout: string;
  stderr: string;
}

/** The streams of a `phase: 'output'` record; empty when neither tag matched. */
export function parseShellOutput(text: string): ShellOutput {
  const stdout = extractBashTag(text, 'bash-stdout') ?? '';
  const stderr = extractBashTag(text, 'bash-stderr') ?? '';
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}
