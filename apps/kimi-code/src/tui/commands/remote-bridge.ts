/**
 * The `/remote connect` slash-command bridge (`SessionCommandBridge` for the
 * embedded kap-server): remote clients (the hub web UI) run THIS TUI's own
 * command grammar instead of a second, drift-prone reimplementation.
 *
 * `execute` hands the raw composer line to the same `dispatchInput` entry the
 * Enter key uses — unknown words, busy-gating, skill/plugin resolution, and
 * every handler semantic stay exactly the typed-in-TUI ones. The host's three
 * output methods (`showNotice` / `showError` / `showStatus`) are shadowed on a
 * prototype wrapper so the lines ALSO travel back as the wire result (the
 * real methods still run — the TUI shows what the remote side did).
 *
 * Session discipline: a command acts on the session the TUI is SHOWING — the
 * dispatch and its handlers know no other. A line addressed at any other
 * session is refused up front rather than applied to the wrong one.
 *
 * Await bound: dispatch is awaited, but picker/panel commands (e.g. `/model`
 * with no args) park until someone answers in the TUI. The bridge returns
 * after {@link INTERACTIVE_NOTICE_MS} with whatever lines exist plus a note —
 * the parked command stays alive and its effects still land when finished.
 */

import type { SessionCommandBridge, SessionCommandInfo, SessionCommandResult } from '@moonshot-ai/kap-server';

import { BUILTIN_SLASH_COMMANDS } from './registry';
import type { SlashCommandHost } from './dispatch';

const INTERACTIVE_NOTICE_MS = 10_000;

export function createTuiCommandBridge(
  host: SlashCommandHost,
  run: (host: SlashCommandHost, input: string) => Promise<void>,
): SessionCommandBridge {
  return {
    catalog: () => buildCatalog(host),
    execute: (sessionId, input) => execute(host, run, sessionId, input),
  };
}

function buildCatalog(host: SlashCommandHost): readonly SessionCommandInfo[] {
  const rows: SessionCommandInfo[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
    name: command.name,
    aliases: [...command.aliases],
    usage:
      'argumentHint' in command && command.argumentHint !== undefined
        ? `/${command.name} ${command.argumentHint}`
        : `/${command.name}`,
    description: command.description,
  }));
  for (const [commandName, skillName] of host.skillCommandMap) {
    rows.push({
      name: commandName,
      aliases: [],
      usage: `/${commandName}`,
      description: `Skill: ${skillName}`,
    });
  }
  for (const commandName of host.pluginCommandMap.keys()) {
    rows.push({
      name: commandName,
      aliases: [],
      usage: `/${commandName}`,
      description: `Plugin command: ${host.pluginCommandMap.get(commandName) ?? commandName}`,
    });
  }
  return rows;
}

async function execute(
  host: SlashCommandHost,
  run: (host: SlashCommandHost, input: string) => Promise<void>,
  sessionId: string,
  rawInput: string,
): Promise<SessionCommandResult> {
  const input = rawInput.trim();
  const active = host.session;
  if (active === undefined || active.id !== sessionId) {
    return {
      notices: [],
      errors: [
        active === undefined
          ? 'the connected TUI is not showing any session right now'
          : `commands run in the session the TUI is showing (${active.id}) — switch the TUI to ${sessionId} first`,
      ],
    };
  }

  const notices: string[] = [];
  const errors: string[] = [];
  const wrapped = Object.create(host, {
    showNotice: {
      value: (title: string, detail?: string) => {
        notices.push(detail === undefined ? title : `${title}\n${detail}`);
        host.showNotice(title, detail);
      },
    },
    showError: {
      value: (msg: string) => {
        errors.push(msg);
        host.showError(msg);
      },
    },
    showStatus: {
      value: (msg: string, color?: Parameters<SlashCommandHost['showStatus']>[1]) => {
        notices.push(msg);
        host.showStatus(msg, color);
      },
    },
  }) as SlashCommandHost;

  const { outcome } = await raceWithTimeout(run(wrapped, input));
  if (outcome === 'failed') {
    errors.push('the command failed while running in the TUI');
  } else if (outcome === 'timeout') {
    notices.push(
      'this command opened interactive UI in the TUI — finish it there; its effects still apply',
    );
  }
  return { notices, errors };
}

/**
 * Await with an interactive-UI bound. Rejection never escapes (it becomes an
 * outcome value, INCLUDING after a timeout — an unguarded late rejection from
 * a parked picker command would otherwise be process-fatal).
 */
async function raceWithTimeout(promise: Promise<void>): Promise<{
  outcome: 'done' | 'failed' | 'timeout';
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), INTERACTIVE_NOTICE_MS);
  });
  const settled = promise.then(
    () => 'done' as const,
    () => 'failed' as const,
  );
  const outcome = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return { outcome };
}
