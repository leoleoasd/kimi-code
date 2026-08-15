export type MediaUrlKind = 'audio' | 'image' | 'video';

export function mediaUrlPartToText(kind: MediaUrlKind, url: string): string {
  const summary = summarizeDataUrl(url);
  if (summary !== undefined) {
    const size = summary.bytes !== undefined ? `, ${formatByteSize(summary.bytes)}` : '';
    return `[${kind} ${summary.mime}${size}]`;
  }
  const blobRefMime = summarizeBlobRef(url);
  if (blobRefMime !== undefined) {
    // The bytes live in the engine's blob store — the mime is all the replay
    // transcript knows, so mark the ref without a size.
    return `[${kind} ${blobRefMime}]`;
  }
  return `<${kind} url="${escapeAttribute(url)}">`;
}

/** `blobref:<mime>;<hash>` — the engine's blob-store refs for offloaded media. */
function summarizeBlobRef(url: string): string | undefined {
  if (!url.startsWith('blobref:')) return undefined;
  const mime = url.slice('blobref:'.length).split(';')[0];
  return mime !== undefined && mime.length > 0 ? mime : undefined;
}

export function summarizeDataUrl(url: string): { mime: string; bytes?: number } | undefined {
  if (!url.startsWith('data:')) return undefined;
  const commaIndex = url.indexOf(',');
  const header =
    commaIndex >= 0 ? url.slice('data:'.length, commaIndex) : url.slice('data:'.length);
  const data = commaIndex >= 0 ? url.slice(commaIndex + 1) : '';
  const [rawMime, ...params] = header.split(';');
  const mime = rawMime !== undefined && rawMime.length > 0 ? rawMime : 'application/octet-stream';
  const isBase64 = params.some((param) => param.toLowerCase() === 'base64');
  return {
    mime,
    bytes: isBase64 ? estimateBase64Bytes(data) : undefined,
  };
}

function estimateBase64Bytes(data: string): number {
  const compact = data.replaceAll(/\s/g, '');
  if (compact.length === 0) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${formatOneDecimal(kib)} KB`;
  return `${formatOneDecimal(kib / 1024)} MB`;
}

function formatOneDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
