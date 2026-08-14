/**
 * Small self-written markdown renderer (NO dependency): paragraphs, fenced
 * code (``` / ~~~ with a language chip + copy button), inline `code`,
 * **bold**, *italic*, ~~strike~~, `#`–`######` headers, blockquotes,
 * unordered/ordered lists, links (http(s) only, target=_blank rel), and
 * simple pipe tables.
 *
 * Streaming-safety: the assistant text arrives as a growing cumulative
 * string, so the component re-parses the WHOLE string on every render —
 * pure-string parsing, memoized on the text value via `useMemo`. An
 * unterminated fence or half-typed construct simply renders as its current
 * (open) form, which is exactly what mid-token text wants. Nothing is
 * injected through `dangerouslySetInnerHTML`: parsers produce plain strings
 * that React text-nodes escape, so user text can never become markup; links
 * are fenced to http(s):// at parse time.
 */

import { useMemo, useState, type ReactNode } from 'react';

// ------------------------------------------------------------------ blocks

export type MdBlock =
  | { readonly kind: 'code'; readonly content: string; readonly lang?: string }
  | { readonly kind: 'heading'; readonly level: number; readonly content: string }
  | { readonly kind: 'quote'; readonly content: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly header: readonly string[]; readonly rows: readonly string[][] }
  | { readonly kind: 'paragraph'; readonly content: string };

interface FenceRegion {
  readonly kind: 'code' | 'prose';
  readonly content: string;
  readonly lang?: string;
}

/**
 * Split source into fenced-code / prose regions, line by line: a line of
 * ```info or ~~~info opens a fence, a bare ``` / ~~~ line closes it. An
 * unterminated fence runs to the end of the input (streaming text renders
 * mid-token, so the open tail is the common case, not an error).
 */
export function splitMarkdownBlocks(source: string): readonly FenceRegion[] {
  const blocks: FenceRegion[] = [];
  const openRe = /^(`{3,}|~{3,})(.*)$/;
  let textLines: string[] = [];
  let codeLines: string[] | null = null;
  let marker = '';
  let lang = '';

  const flushText = (): void => {
    const text = textLines.join('\n');
    textLines = [];
    if (text.trim() !== '') blocks.push({ kind: 'prose', content: text });
  };
  const flushCode = (): void => {
    if (codeLines === null) return;
    const content = codeLines.join('\n');
    codeLines = null;
    blocks.push({ kind: 'code', content, ...(lang === '' ? {} : { lang }) });
    marker = '';
    lang = '';
  };

  for (const line of source.split('\n')) {
    const match = openRe.exec(line);
    if (codeLines === null) {
      if (match !== null && match[1] !== undefined) {
        flushText();
        codeLines = [];
        marker = match[1].charAt(0);
        lang = (match[2] ?? '').trim();
      } else {
        textLines.push(line);
      }
      continue;
    }
    // Inside a fence: only a bare fence of the same marker closes it.
    if (
      match !== null &&
      match[1] !== undefined &&
      match[1].charAt(0) === marker &&
      (match[2] ?? '').trim() === ''
    ) {
      flushCode();
      continue;
    }
    codeLines.push(line);
  }
  flushText();
  flushCode();
  return blocks;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const UL_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM_RE = /^\s*\d{1,9}[.)]\s+(.*)$/;
/** A delimiter row is cells made only of at least 3 dashes plus optional colons. */
function isTableDelimRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

/** Pipe-table row → cells; leading/trailing pipe optional. */
export function splitTableRow(line: string): readonly string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  if (row.trim() === '') return [];
  return row.split('|').map((cell) => cell.trim());
}

/** Parse one prose region (no fences inside) into structural blocks. */
function parseProse(source: string, out: MdBlock[]): void {
  const lines = source.split('\n');
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text !== '') out.push({ kind: 'paragraph', content: text });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      flushParagraph();
      out.push({ kind: 'heading', level: heading[1].length, content: heading[2].trim() });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length) {
        const match = QUOTE_RE.exec(lines[i] ?? '');
        if (match === null) break;
        quote.push(match[1] ?? '');
        i += 1;
      }
      out.push({ kind: 'quote', content: quote.join('\n').trim() });
      continue;
    }

    if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) {
      flushParagraph();
      const ordered = OL_ITEM_RE.test(line) && !UL_ITEM_RE.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const match = (ordered ? OL_ITEM_RE : UL_ITEM_RE).exec(lines[i] ?? '');
        if (match === null) break;
        items.push((match[1] ?? '').trim());
        i += 1;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }

    // Table: a header row, then the -{3,} delimiter row, then body rows.
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && isTableDelimRow(next)) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i] ?? '';
        if (!rowLine.includes('|') || rowLine.trim() === '') break;
        rows.push([...splitTableRow(rowLine)]);
        i += 1;
      }
      out.push({ kind: 'table', header, rows });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
}

/** Full parse: fences split first, prose regions get structural blocks. */
export function parseMarkdown(source: string): readonly MdBlock[] {
  const out: MdBlock[] = [];
  for (const region of splitMarkdownBlocks(source)) {
    if (region.kind === 'code') {
      out.push({ kind: 'code', content: region.content, ...(region.lang === undefined ? {} : { lang: region.lang }) });
    } else {
      parseProse(region.content, out);
    }
  }
  return out;
}

// ------------------------------------------------------------------ inline

export type MdInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'bold'; readonly children: readonly MdInline[] }
  | { readonly kind: 'italic'; readonly children: readonly MdInline[] }
  | { readonly kind: 'strike'; readonly children: readonly MdInline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly MdInline[] };

/** An inline opener may not start inside a word (avoids a*b*c math). */
function canOpen(src: string, at: number): boolean {
  if (at === 0) return true;
  return !/[A-Za-z0-9]/.test(src.charAt(at - 1));
}

/**
 * Minimal inline scanner, ordered by precedence: code span, link, bold,
 * strike, italic. Each construct needs both delimiters present, otherwise the
 * opening marker stays literal — half-typed mid-token input renders as-is.
 */
export function parseInline(src: string): readonly MdInline[] {
  const out: MdInline[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer !== '') out.push({ kind: 'text', text: buffer });
    buffer = '';
  };

  while (i < src.length) {
    const rest = src.slice(i);

    if (rest.startsWith('`')) {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith('[')) {
      const close = src.indexOf('](', i + 1);
      if (close > i) {
        const hrefEnd = src.indexOf(')', close + 2);
        if (hrefEnd > close + 2) {
          const href = src.slice(close + 2, hrefEnd).trim();
          const label = src.slice(i + 1, close);
          if (/^https?:\/\//i.test(href) && label !== '') {
            flush();
            out.push({ kind: 'link', href, children: parseInline(label) });
            i = hrefEnd + 1;
            continue;
          }
        }
      }
    }

    const marker = rest.startsWith('**')
      ? '**'
      : rest.startsWith('~~')
        ? '~~'
        : rest.startsWith('*') || rest.startsWith('_')
          ? rest.charAt(0)
          : null;
    if (marker !== null && canOpen(src, i)) {
      const innerStart = i + marker.length;
      const end = src.indexOf(marker, innerStart);
      if (end > innerStart) {
        flush();
        const children = parseInline(src.slice(innerStart, end));
        out.push(
          marker === '**'
            ? { kind: 'bold', children }
            : marker === '~~'
              ? { kind: 'strike', children }
              : { kind: 'italic', children },
        );
        i = end + marker.length;
        continue;
      }
    }

    buffer += src.charAt(i);
    i += 1;
  }
  flush();
  return out;
}

function renderInline(parts: readonly MdInline[], keyPrefix: string): ReactNode[] {
  return parts.map((part, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (part.kind) {
      case 'text':
        return <span key={key}>{part.text}</span>;
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-neutral-800/80 px-1 py-0.5 font-mono text-[0.85em] text-neutral-200"
          >
            {part.text}
          </code>
        );
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-neutral-50">
            {renderInline(part.children, key)}
          </strong>
        );
      case 'italic':
        return <em key={key}>{renderInline(part.children, key)}</em>;
      case 'strike':
        return <s key={key}>{renderInline(part.children, key)}</s>;
      case 'link':
        return (
          <a
            key={key}
            className="break-all text-sky-400 underline decoration-sky-800 underline-offset-2 hover:text-sky-300"
            href={part.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInline(part.children, key)}
          </a>
        );
      default:
        return null;
    }
  });
}

/** Inline content of a block; a trailing newline renders as a <br/>. */
function InlineText({ text, keyPrefix }: { text: string; keyPrefix: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span key={`${keyPrefix}.${i}`}>
          {i > 0 ? <br /> : null}
          {renderInline(parseInline(line), `${keyPrefix}.${i}`)}
        </span>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ render

function CodeBlock({ content, lang }: { content: string; lang?: string | undefined }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (navigator.clipboard === undefined) return;
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1200);
      })
      .catch(() => undefined);
  };
  return (
    <div className="relative mb-2 last:mb-0">
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5">
        {lang !== undefined && lang !== '' ? (
          <span className="rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500 select-none">
            {lang}
          </span>
        ) : null}
        <button
          className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:text-neutral-200"
          onClick={copy}
          title="copy code"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-neutral-950 p-2.5 font-mono text-[12px] leading-relaxed text-neutral-200">
        <code>{content}</code>
      </pre>
    </div>
  );
}

const HEADING_CLASSES: readonly string[] = [
  'mt-3 mb-1.5 text-[17px] font-semibold text-neutral-50',
  'mt-3 mb-1.5 text-[15px] font-semibold text-neutral-50',
  'mt-2.5 mb-1 text-[14px] font-semibold text-neutral-100',
  'mt-2 mb-1 text-[13px] font-semibold text-neutral-100',
  'mt-2 mb-1 text-[13px] font-medium text-neutral-200',
  'mt-1.5 mb-1 text-[12px] font-medium text-neutral-300',
];

function BlockView({ block, index }: { block: MdBlock; index: number }) {
  const keyPrefix = `b${index}`;
  switch (block.kind) {
    case 'code':
      return <CodeBlock content={block.content} lang={block.lang} />;
    case 'heading': {
      const cls = HEADING_CLASSES[Math.min(block.level, 6) - 1] ?? HEADING_CLASSES[5];
      return (
        <div className={`${cls} first:mt-0`}>
          <InlineText text={block.content} keyPrefix={keyPrefix} />
        </div>
      );
    }
    case 'quote':
      return (
        <blockquote className="mb-2 border-l-2 border-neutral-700 pl-3 text-neutral-400 last:mb-0">
          <InlineText text={block.content} keyPrefix={keyPrefix} />
        </blockquote>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          className={`mb-2 pl-5 last:mb-0 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-neutral-600`}
        >
          {block.items.map((item, i) => (
            <li key={`${keyPrefix}.${i}`} className="mb-0.5 last:mb-0">
              <InlineText text={item} keyPrefix={`${keyPrefix}.${i}`} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'table':
      return (
        <div className="mb-2 overflow-x-auto last:mb-0">
          <table className="border-collapse text-[12px]">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th
                    key={`${keyPrefix}.h${i}`}
                    className="border border-neutral-800 bg-neutral-900 px-2 py-1 text-left font-medium text-neutral-300"
                  >
                    <InlineText text={cell} keyPrefix={`${keyPrefix}.h${i}`} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${keyPrefix}.r${r}`}>
                  {row.map((cell, c) => (
                    <td
                      key={`${keyPrefix}.r${r}.${c}`}
                      className="border border-neutral-800 px-2 py-1 text-neutral-300"
                    >
                      <InlineText text={cell} keyPrefix={`${keyPrefix}.r${r}.${c}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'paragraph':
      return (
        <p className="mb-2 whitespace-pre-wrap last:mb-0">
          <InlineText text={block.content} keyPrefix={keyPrefix} />
        </p>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  // Whole-string re-parse per render — the memo key IS the accumulated text,
  // so identical frames are free and streaming frames pay one flat parse.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="text-[13px] leading-relaxed text-neutral-100">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} index={i} />
      ))}
    </div>
  );
}
