/** Small shared UI primitives: badges, buttons, JSON dump, relative time. */

import { useState } from 'react';

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'sky' | 'violet';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-800 text-neutral-300',
    green: 'bg-emerald-900/60 text-emerald-300',
    amber: 'bg-amber-900/60 text-amber-300',
    red: 'bg-red-900/60 text-red-300',
    sky: 'bg-sky-900/60 text-sky-300',
    violet: 'bg-violet-900/60 text-violet-300',
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`} title={title}>
      {children}
    </span>
  );
}

export function ActionButton({
  children,
  onClick,
  danger,
  disabled,
  title,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  /** Extra tailwind classes (e.g. full-width on narrow screens). */
  className?: string;
}) {
  return (
    <button
      className={`min-h-[40px] rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${
        danger
          ? 'border-red-900/70 text-red-400 hover:bg-red-950/60'
          : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
      }${className !== undefined ? ` ${className}` : ''}`}
      disabled={disabled}
      title={title}
      onClick={() => {
        void onClick();
      }}
    >
      {children}
    </button>
  );
}

export function JsonView({ data, empty }: { data: unknown; empty?: string }) {
  const [open, setOpen] = useState(false);
  if (data === undefined || data === null) {
    return <div className="text-[11px] text-neutral-600 italic">{empty ?? 'no data'}</div>;
  }
  const text = JSON.stringify(data, null, 2);
  const long = text.length > 500;
  return (
    <pre
      className={`cursor-text overflow-auto rounded bg-neutral-950/70 p-2 font-mono text-[11px] leading-relaxed text-neutral-300 ${
        long && !open ? 'max-h-48' : 'max-h-[28rem]'
      }`}
      onClick={() => {
        if (long) setOpen((v) => !v);
      }}
      title={long ? 'click to expand / collapse' : undefined}
    >
      {long && !open ? `${text.slice(0, 500)}\n… (${text.length} chars, click to expand)` : text}
    </pre>
  );
}

export function relTime(epochMs: number | undefined): string {
  if (epochMs === undefined) return '';
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleDateString();
}

/** Render an unknown thrown value as display text (never "[object Object]"). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return String(error);
  return JSON.stringify(error) ?? 'unknown error';
}

export function ErrorLine({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <div className="rounded bg-red-950/50 px-2 py-1 text-[11px] break-words text-red-400">
      {errorMessage(error)}
    </div>
  );
}

/** Tiny spinning arc. `light` for on-accent backgrounds (the Send button). */
export function Spinner({ light }: { light?: boolean }) {
  return (
    <span
      className={`inline-block h-3 w-3 animate-spin rounded-full border ${
        light === true ? 'border-white/40 border-t-white' : 'border-neutral-600 border-t-sky-400'
      }`}
      role="status"
      aria-label="working"
    />
  );
}

/** Full-width status strip (offline agents, stream health, …). */
export function Banner({
  tone = 'amber',
  children,
}: {
  tone?: 'amber' | 'red' | 'sky';
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    amber: 'border-amber-900/60 bg-amber-950/40 text-amber-300',
    red: 'border-red-900/60 bg-red-950/40 text-red-300',
    sky: 'border-sky-900/60 bg-sky-950/40 text-sky-300',
  };
  return (
    <div className={`border-b px-3 py-1.5 text-[11px] ${tones[tone]} lg:px-4`}>{children}</div>
  );
}
