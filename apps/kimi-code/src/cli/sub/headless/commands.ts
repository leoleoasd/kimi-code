/**
 * The headless host's slash-command bridge. A `kimi headless` agent has no
 * TUI to borrow a grammar from, so it publishes this deliberately small,
 * always-non-interactive set — every entry resolves straight against engine
 * services. Anything outside the set is rejected with the available list
 * (the composer forwards every `/…` line, so "unknown" is the common case).
 */

import {
  ISessionMetadata,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type {
  SessionCommandBridge,
  SessionCommandInfo,
  SessionCommandResult,
} from '@moonshot-ai/kap-server';

const COMMANDS: readonly SessionCommandInfo[] = [
  {
    name: 'title',
    aliases: ['rename'],
    usage: '/title <title>',
    description: 'Set or show the session title',
  },
  {
    name: 'help',
    aliases: [],
    usage: '/help',
    description: 'List the commands this headless agent exposes',
  },
];

const HELP_TEXT = `available commands: ${COMMANDS.map((c) => c.usage).join(', ')}`;

/**
 * `coreReady` resolves once the server boots (the engine scope exists only
 * after `startServer`); `execute` simply awaits it — no request can beat the
 * listener by more than a microtask.
 */
export function createHeadlessCommandBridge(coreReady: Promise<Scope>): SessionCommandBridge {
  return {
    catalog: () => COMMANDS,
    execute: async (sessionId, input) => {
      const core = await coreReady;
      const [word = '', ...rest] = input.trim().replace(/^\//, '').split(/\s+/);
      const name = word.toLowerCase();
      if (name === 'help') {
        return { notices: [HELP_TEXT], errors: [] };
      }
      if (name === 'title' || name === 'rename') {
        return runTitle(core, sessionId, rest.join(' ').trim());
      }
      return {
        notices: [],
        errors: [`unknown command '/${word}' on a headless agent — ${HELP_TEXT}`],
      };
    },
  };
}

async function runTitle(
  core: Scope,
  sessionId: string,
  title: string,
): Promise<SessionCommandResult> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    return { notices: [], errors: [`session ${sessionId} not found`] };
  }
  const metadata = session.accessor.get(ISessionMetadata);
  if (title === '') {
    const current = (await metadata.read()).title;
    return { notices: [`current title: ${current ?? '(untitled)'}`], errors: [] };
  }
  await metadata.setTitle(title);
  return { notices: [`session title set to "${title}"`], errors: [] };
}
