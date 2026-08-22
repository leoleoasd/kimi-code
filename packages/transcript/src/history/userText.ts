export type UserTextClassification =
  | { readonly kind: 'hub'; readonly from: string; readonly text: string }
  | { readonly kind: 'internal' }
  | { readonly kind: 'user'; readonly text: string };

const HUB_MESSAGE_HEADER = /^\[kimi-hub message from ([^\]]+)\][ \t]*\r?\n/;

const INTERNAL_ENVELOPES: readonly RegExp[] = [
  /\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g,
  /\s*Skill tool loaded instructions for this request\. Follow them\.\s*/g,
  /\s*<skill-loaded\b[\s\S]*?<\/skill-loaded>\s*/g,
];

/**
 * Split a stored user-role text into what it actually is: a cross-session hub
 * message (envelope `[kimi-hub message from X]` + disclaimer paragraph +
 * body), a pure harness-injection envelope (goal/plan reminders, skill-loaded
 * payloads — model-facing scaffolding, never conversation), or genuine user
 * text with any such envelopes stripped out. Live projection and the cold
 * fold share this so both timelines classify the same way.
 */
export function classifyUserText(text: string): UserTextClassification {
  const hub = HUB_MESSAGE_HEADER.exec(text);
  if (hub !== null) {
    const from = hub[1] ?? '';
    const rest = text.slice(hub[0].length);
    const blank = /\r?\n\r?\n/.exec(rest);
    const body = (blank === null ? rest : rest.slice(blank.index)).trim();
    return { kind: 'hub', from, text: body };
  }
  let out = text;
  for (const pattern of INTERNAL_ENVELOPES) {
    out = out.replace(pattern, '\n');
  }
  out = out.replaceAll(/\n{3,}/g, '\n\n').trim();
  if (out === '' && text.trim() !== '') return { kind: 'internal' };
  return { kind: 'user', text: out };
}
