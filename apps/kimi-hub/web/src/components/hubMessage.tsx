export function readHubFromOrigin(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const hubFrom = (payload as { hubFrom?: unknown }).hubFrom;
  return typeof hubFrom === 'string' && hubFrom.length > 0 ? hubFrom : undefined;
}

/**
 * Cross-session hub messages are their own category: a bordered card
 * (labelled `hub · <sender descriptor>`) rather than a plain user bubble.
 * Used for both idle-delivered messages (own turn, origin payload) and
 * mid-turn injections (user text frames tagged `hubFrom`).
 */
export function HubMessageCard({ from, text }: { from: string; text: string }) {
  return (
    <div className="max-w-[85%] rounded-lg border border-sky-800/60 bg-sky-900/20 px-3 py-2 text-[13px] text-neutral-100 sm:max-w-[80%]">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-sky-300/80">
        <span>hub</span>
        <span className="text-neutral-500">·</span>
        <span className="break-all">{from}</span>
      </div>
      <div className="whitespace-pre-wrap">{text}</div>
    </div>
  );
}
