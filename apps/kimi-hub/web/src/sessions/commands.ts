/**
 * Composer slash-command routing for the hub web UI.
 *
 * There is exactly ONE command grammar — the connected TUI's own dispatch —
 * and this module deliberately knows almost nothing about it: any `/…` line
 * is forwarded verbatim to the agent (`POST :command`, executed by the TUI's
 * dispatch through the injected command bridge; the answer's lines surface as
 * the composer notice). Unknown words, busy-gating, and availability are the
 * TUI's calls, made over there — never re-judged here.
 *
 * Only two actions stay local, because their substance IS the browser, not
 * the agent: `/copy` (the clipboard lives here) and `/export-debug-zip` (the
 * download lives here — the TUI's own variant lands on the agent machine).
 * One more class never leaves the page: the host's INTERACTIVE-dialog
 * commands (`DIALOG_COMMANDS`, e.g. bare `/model`) would pop a TUI overlay on
 * the agent's screen with no way for the page to see or drive it. `/model`
 * normally never gets this far — the composer's ModelPicker popup intercepts
 * the word while it's typed — so this notice is the fallback for a session
 * whose model catalog is unavailable. Everything else — including words this
 * build has never heard of — reaches the dispatch untouched.
 *
 * Routing boundary: only a single-line `/…` input is ever treated as a
 * command. Multi-line pastes always go through as prompts.
 */

import type { TranscriptItem } from '@moonshot-ai/transcript';

import type { HttpEndpoint } from '#/http';

import { exportSession, runSessionCommand } from './api';

export type ComposerAction =
  | { readonly kind: 'remote'; readonly input: string }
  | { readonly kind: 'copy' }
  | { readonly kind: 'export-debug-zip' }
  | { readonly kind: 'notice'; readonly notice: string };

export interface ParsedComposerCommand {
  readonly kind: 'action';
  readonly action: ComposerAction;
}

/** Everything a local action may touch — the HTTP endpoint plus the browser-side effects. */
export interface CommandContext extends HttpEndpoint {
  readonly sessionId: string;
  /**
   * `/copy` — the last assistant text frame; `undefined` when the transcript
   * holds none yet. The runner sources it from the channel's `state.items`
   * (`lastAssistantText` below) so the store module stays untouched.
   */
  readonly getLastAssistantText?: () => string | undefined;
  /** `/copy` — injectable for tests; production falls back to `navigator.clipboard`. */
  readonly clipboard?: { writeText(text: string): Promise<void> };
  /** `/export-debug-zip` — injectable for tests; production falls back to an object URL download. */
  readonly download?: (blob: Blob, filename: string) => void;
}

/** What the runner hands to ChatView: one completion notice line. */
export interface CommandResult {
  readonly notice: string;
}

/**
 * The browser-local commands — also the composer's hint fallback when the
 * agent's own catalog (`GET …/commands`) is unavailable (headless agent).
 */
export const LOCAL_COMMANDS = [
  { usage: '/copy', description: 'Copy the last assistant message to the clipboard' },
  { usage: '/export-debug-zip', description: 'Download the session as a debug ZIP archive' },
] as const;

/**
 * Bare dialog commands → the short-circuit notice the composer surfaces.
 * Keys are the full lines (bare form only — an /xxx with arguments may well
 * behead the dialog on the host and is forwarded as usual).
 */
const DIALOG_COMMAND_NOTICES: Record<string, string> = {
  '/model': "the TUI /model dialog opens on the agent's own screen, not here — type /model to open the model picker above the composer, or use the dropdown in the chat header",
};

/** The DOM fallback for `/export-debug-zip`: anchor-click an object URL, revoke deferred. */
function defaultDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Defer revocation so the click has time to consume the URL.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * Classify one composer input (`input` arrives already trimmed). `null` means
 * "not a command — send as a prompt". `/copy` and `/export-debug-zip` (bare)
 * stay browser-local; every other slash-prefixed line forwards to the agent.
 * A multi-line input is never a command: slash commands are single-line by
 * definition, and a pasted snippet whose first line begins with `/` (a `//`
 * comment, a `/`-relative path list) must reach the agent as text, not be
 * swallowed by the host's dispatch.
 */
export function parseComposerCommand(input: string): ParsedComposerCommand | null {
  if (!input.startsWith('/')) return null;
  if (input.includes('\n')) return null;
  if (input === '/copy') return { kind: 'action', action: { kind: 'copy' } };
  if (input === '/export-debug-zip') {
    return { kind: 'action', action: { kind: 'export-debug-zip' } };
  }
  const dialogNotice = DIALOG_COMMAND_NOTICES[input];
  if (dialogNotice !== undefined) {
    return { kind: 'action', action: { kind: 'notice', notice: dialogNotice } };
  }
  return { kind: 'action', action: { kind: 'remote', input } };
}

/** ChatView's runner: local effects run here; `/…` lines ride the agent's command bridge. */
export async function runComposerCommand(
  action: ComposerAction,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (action.kind === 'notice') {
    return { notice: action.notice };
  }
  if (action.kind === 'remote') {
    const result = await runSessionCommand({ ...ctx, input: action.input });
    const notice = [...result.errors, ...result.notices].join('\n');
    return { notice };
  }
  if (action.kind === 'copy') {
    const text = ctx.getLastAssistantText?.();
    if (text === undefined || text.trim() === '') {
      return { notice: 'no assistant message to copy' };
    }
    const clipboard = ctx.clipboard ?? navigator.clipboard;
    if (clipboard === undefined) {
      throw new Error('clipboard unavailable — the page is not a secure context');
    }
    await clipboard.writeText(text);
    return { notice: `copied to clipboard (${String(text.length)} characters)` };
  }
  const blob = await exportSession(ctx);
  const filename = `session-${ctx.sessionId}-export.zip`;
  (ctx.download ?? defaultDownload)(blob, filename);
  return { notice: `export complete — downloaded ${filename}` };
}

/**
 * The last assistant text frame, newest first — mirrors the TUI's `/copy`
 * source (the RENDERED transcript, not model context, so it survives
 * compaction). User-role frames, other frame kinds, and whitespace-only text
 * are skipped; `undefined` when the transcript holds no assistant text.
 */
export function lastAssistantText(items: readonly TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item === undefined || item.kind !== 'turn') continue;
    for (let s = item.steps.length - 1; s >= 0; s -= 1) {
      const step = item.steps[s];
      if (step === undefined) continue;
      for (let f = step.frames.length - 1; f >= 0; f -= 1) {
        const frame = step.frames[f];
        if (frame === undefined || frame.kind !== 'text' || frame.role !== 'assistant') continue;
        if (frame.text.trim() !== '') return frame.text;
      }
    }
  }
  return undefined;
}
