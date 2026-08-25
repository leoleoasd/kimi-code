/**
 * `/api/v1/files` client + composer attachment state for image prompts.
 *
 * Wire contract (confirmed against kap-server):
 *
 *   POST /api/v1/files            multipart/form-data, ONE file part (field
 *                                 name `file`) → envelope `{ code, data: FileMeta }`
 *                                 where FileMeta = `{ id, name, media_type,
 *                                 size, created_at, expires_at? }` (snake_case;
 *                                 `packages/kap-server/src/routes/files.ts`,
 *                                 `fileMetaSchema` in agent-core-v2's fileService).
 *   GET  /api/v1/files/{file_id}  binary stream (NO envelope); Bearer token via
 *                                 the `authorization` header.
 *
 * An uploaded image goes into a prompt as a `file`-sourced image content part:
 *
 *   { type: 'image', source: { kind: 'file', file_id: '<id>' } }
 *
 * (`imageContentSchema` / `imageSourceSchema` in
 * `packages/kap-server/src/protocol/message.ts`.) The prompt body is then
 * `content: [...imageParts, ...(text ? [{ type: 'text', text }] : [])]` on
 * `POST /api/v1/sessions/{sid}/prompts` — `sendPrompt` in `./api.ts` predates
 * attachments and submits the text-only body; it stays the plain-text path.
 *
 * NOTE on scoped agents: `/files` is an agent host surface, so a
 * session-scoped connector gets a 40302 envelope error here (the composer
 * surfaces it on the failed chip with a retry/remove affordance) — see the
 * hub AGENTS.md non-goals.
 */

import { EnvelopeError, type HttpEndpoint } from '#/http';

// ------------------------------------------------------------------ upload

/** In-app shape of one uploaded image (the wire `media_type` camelCased). */
export interface UploadedImage {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
}

const EXTENSIONS_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/**
 * Clipboard payloads usually carry an empty or generic name ('image.png'):
 * synthesize `pasted-<n>.<ext>`; the extension follows the media type. Also
 * used for dropped files with an implausible name.
 */
export function fallbackImageName(index: number, mediaType: string): string {
  return `pasted-${index}${EXTENSIONS_BY_MEDIA_TYPE[mediaType] ?? '.png'}`;
}

/**
 * Upload one image file to the agent through the hub. Mirrors the shared http
 * helpers' envelope semantics (`src/http.ts` exposes GET/POST-JSON only — this
 * is the one multipart call of the app, so the unwrap lives here on the same
 * error classes).
 */
export async function uploadImage(
  endpoint: HttpEndpoint & { file: File | Blob; fileName: string },
): Promise<UploadedImage> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const form = new FormData();
  // The caller owns the naming decision (paste → `pasted-<n>.png` fallback,
  // drop → the real file name): clipboard names like 'image.png' are junk.
  form.append('file', endpoint.file, endpoint.fileName);
  const headers: Record<string, string> = {};
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const res = await doFetch(`${endpoint.baseUrl}/api/v1/files`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if (!res.ok) {
    throw new Error(`http ${res.status} ${res.statusText}`);
  }
  const envelope = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
  const code = typeof envelope.code === 'number' ? envelope.code : undefined;
  if (code === undefined) {
    throw new Error(`file upload: unexpected response shape (http ${res.status})`);
  }
  if (code !== 0) {
    const msg = typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : 'upload failed';
    throw new EnvelopeError(code, msg);
  }
  const data = envelope.data as Record<string, unknown> | null;
  if (
    data === null ||
    typeof data !== 'object' ||
    typeof data['id'] !== 'string' ||
    typeof data['name'] !== 'string'
  ) {
    throw new Error('file upload: unexpected response shape');
  }
  return {
    id: data['id'],
    name: data['name'],
    mediaType: typeof data['media_type'] === 'string' ? data['media_type'] : 'application/octet-stream',
    size: typeof data['size'] === 'number' ? data['size'] : 0,
  };
}

// ------------------------------------------------------------------ preview

/**
 * An `<img>` cannot carry the hub's Bearer header, so thumbnails are read
 * back with a fetch and served from an object URL. The URL is returned to the
 * caller, who MUST pair it with `revokePreviewUrl` when the chip unmounts (the
 * composer revokes on remove / successful send).
 *
 * `createObjectUrl` is injectable for tests; production uses the DOM global.
 */
export async function buildImagePreviewUrl(
  endpoint: HttpEndpoint & {
    fileId: string;
    createObjectUrl?: (blob: Blob) => string;
  },
): Promise<string> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/files/${encodeURIComponent(endpoint.fileId)}`,
    { headers },
  );
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if (!res.ok) {
    throw new Error(`http ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const create = endpoint.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  return create(blob);
}

/** Release an object URL made by `buildImagePreviewUrl`. Safe to call with ''. */
export function revokePreviewUrl(url: string, revokeObjectUrl?: (url: string) => void): void {
  if (url === '') return;
  if (revokeObjectUrl !== undefined) revokeObjectUrl(url);
  else URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------ blobs

/**
 * Engine blob refs: prompt media over ~4 KiB is dehydrated at persistence
 * into the AGENT-scoped blob store, referenced in messages/meta as
 * `blobref:<mime>;<sha256>`. Transcript attachments for these carry
 * `source: { kind: 'blob', ref }` — the ref alone can't ride an <img> (no
 * protocol handler), so the bytes come from the session blob route below.
 */
export function parseBlobRef(ref: string): { mediaType: string; sha256: string } | undefined {
  const match = /^blobref:([^;]+);([0-9a-f]{64})$/i.exec(ref);
  const mediaType = match?.[1];
  const sha256 = match?.[2];
  if (mediaType === undefined || sha256 === undefined) return undefined;
  return { mediaType, sha256 };
}

/** `buildImagePreviewUrl`'s sibling for blob refs — same object-URL contract. */
export async function buildBlobPreviewUrl(
  endpoint: HttpEndpoint & {
    sessionId: string;
    agentId: string;
    ref: string;
    createObjectUrl?: (blob: Blob) => string;
  },
): Promise<string> {
  const parsed = parseBlobRef(endpoint.ref);
  if (parsed === undefined) throw new Error(`malformed blob ref: ${endpoint.ref}`);
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/agents/${encodeURIComponent(endpoint.agentId)}/blobs/${parsed.sha256}`,
    { headers },
  );
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if (!res.ok) {
    throw new Error(`http ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const create = endpoint.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  return create(blob);
}

// ------------------------------------------------------------ session media

/**
 * Session-canonical media (`source.kind === 'session_media'`): the projektor
 * assigns the turn-anchored fileId and the bytes stream from the per-session
 * media route (`/api/v1/sessions/{sid}/media/{fid}`). Same object-URL
 * contract as `buildImagePreviewUrl` — the caller MUST revoke.
 */
export async function buildSessionMediaPreviewUrl(
  endpoint: HttpEndpoint & {
    sessionId: string;
    fileId: string;
    createObjectUrl?: (blob: Blob) => string;
  },
): Promise<string> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/media/${encodeURIComponent(endpoint.fileId)}`,
    { headers },
  );
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if (!res.ok) {
    throw new Error(`http ${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const create = endpoint.createObjectUrl ?? ((b: Blob) => URL.createObjectURL(b));
  return create(blob);
}

// ------------------------------------------------------------------ prompts

/**
 * The `MessageContent` wire parts of one composer submission: the READY image
 * attachments first (in chip order), then the text part when non-empty. Shape
 * per `packages/kap-server/src/protocol/message.ts` (`messageContentSchema`).
 */
export function buildPromptContent(
  text: string,
  images: readonly UploadedImage[],
): readonly Record<string, unknown>[] {
  return [
    ...images.map((image) => ({
      type: 'image',
      source: { kind: 'file', file_id: image.id },
    })),
    ...(text === '' ? [] : [{ type: 'text', text }]),
  ];
}

export interface PromptSubmitResult {
  readonly promptId: string;
  readonly status: 'running' | 'queued' | 'blocked';
}

/**
 * Submit a prompt with image attachments. The plain-text path stays with
 * `sendPrompt` in `./api.ts` (unchanged wire bytes); this one exists because
 * that signature predates attachments and cannot carry content parts.
 */
export async function sendPromptWithImages(
  endpoint: HttpEndpoint & { sessionId: string; text: string; images: readonly UploadedImage[]; steer?: boolean },
): Promise<PromptSubmitResult> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/prompts`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: buildPromptContent(endpoint.text, endpoint.images),
        steer: endpoint.steer === true ? true : undefined,
      }),
    },
  );
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if (!res.ok) {
    throw new Error(`http ${res.status} ${res.statusText}`);
  }
  const envelope = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
  const code = typeof envelope.code === 'number' ? envelope.code : undefined;
  if (code === undefined) {
    throw new Error(`prompt submit: unexpected response shape (http ${res.status})`);
  }
  if (code !== 0) {
    const msg = typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : 'request failed';
    throw new EnvelopeError(code, msg);
  }
  const p = (envelope.data ?? {}) as Record<string, unknown>;
  if (typeof p['prompt_id'] !== 'string' || typeof p['status'] !== 'string') {
    throw new TypeError('prompt submit: unexpected response shape');
  }
  return { promptId: p['prompt_id'], status: p['status'] as PromptSubmitResult['status'] };
}

// ------------------------------------------------------------------ state

/**
 * One composer attachment chip. The `File` is retained so a failed upload can
 * be RETRIED without re-pasting; `fileId` lands when the upload finishes
 * (READY), `previewUrl` when the thumbnail read-back succeeded.
 */
export interface ComposerAttachment {
  readonly localId: string;
  readonly name: string;
  readonly size: number;
  readonly mediaType: string;
  readonly file: File;
  readonly status: 'uploading' | 'ready' | 'failed';
  readonly fileId?: string;
  readonly previewUrl?: string;
  readonly error?: string;
}

export type ComposerAttachmentsAction =
  | { readonly type: 'add'; readonly attachment: ComposerAttachment }
  | { readonly type: 'resolve'; readonly localId: string; readonly fileId: string }
  | { readonly type: 'fail'; readonly localId: string; readonly error: string }
  /** Back to `uploading` (the component re-runs the upload with the kept File). */
  | { readonly type: 'retry'; readonly localId: string }
  | { readonly type: 'preview'; readonly localId: string; readonly previewUrl: string }
  | { readonly type: 'remove'; readonly localId: string }
  | { readonly type: 'clear' };

export function composerAttachmentsReducer(
  state: readonly ComposerAttachment[],
  action: ComposerAttachmentsAction,
): readonly ComposerAttachment[] {
  switch (action.type) {
    case 'add':
      return [...state, action.attachment];
    case 'resolve':
      return state.map((a) =>
        a.localId === action.localId
          ? { ...a, status: 'ready', fileId: action.fileId, error: undefined }
          : a,
      );
    case 'fail':
      return state.map((a) =>
        a.localId === action.localId ? { ...a, status: 'failed', error: action.error } : a,
      );
    case 'retry':
      return state.map((a) =>
        a.localId === action.localId ? { ...a, status: 'uploading', error: undefined } : a,
      );
    case 'preview':
      return state.map((a) =>
        a.localId === action.localId ? { ...a, previewUrl: action.previewUrl } : a,
      );
    case 'remove': {
      const next = state.filter((a) => a.localId !== action.localId);
      return next.length === state.length ? state : next;
    }
    case 'clear':
      return state.length === 0 ? state : [];
  }
}

/** READY attachments as upload parts, in chip order (send order). */
export function readyAttachments(
  state: readonly ComposerAttachment[],
): readonly UploadedImage[] {
  return state
    .filter((a): a is ComposerAttachment & { readonly fileId: string } => a.status === 'ready' && a.fileId !== undefined)
    .map((a) => ({ id: a.fileId, name: a.name, mediaType: a.mediaType, size: a.size }));
}
