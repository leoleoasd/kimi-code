/**
 * /api/v1/files client + attachment reducer: upload envelope unwrap, preview
 * object-URL lifecycle, prompt content building, and the chip state machine.
 */

import { describe, expect, it, vi } from 'vitest';

import { EnvelopeError } from '#/http';
import {
  buildImagePreviewUrl,
  buildPromptContent,
  composerAttachmentsReducer,
  fallbackImageName,
  readyAttachments,
  revokePreviewUrl,
  sendPromptWithImages,
  uploadImage,
  type ComposerAttachment,
} from '#/sessions/files';

const ENDPOINT = { baseUrl: 'http://hub.example.com/agents/a1', token: 'tok' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

const FILE_META = {
  id: 'f-1',
  name: 'pasted-1.png',
  media_type: 'image/png',
  size: 1024,
  created_at: '2026-08-13T00:00:00.000Z',
};

describe('fallbackImageName', () => {
  it('numbers pastes and maps known media types to extensions', () => {
    expect(fallbackImageName(1, 'image/png')).toBe('pasted-1.png');
    expect(fallbackImageName(2, 'image/jpeg')).toBe('pasted-2.jpg');
    expect(fallbackImageName(3, 'application/octet-stream')).toBe('pasted-3.png');
  });
});

describe('uploadImage', () => {
  it('posts one `file` part and unwraps the FileMeta envelope', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const uploaded = await uploadImage({
      ...ENDPOINT,
      file: new File(['bytes'], 'orig.png', { type: 'image/png' }),
      fileName: 'pasted-1.png',
      fetchImpl: async (url, init) => {
        calls.push({ url: requestUrl(url), init });
        return jsonResponse({ code: 0, msg: 'ok', data: FILE_META });
      },
    });
    expect(uploaded).toEqual({ id: 'f-1', name: 'pasted-1.png', mediaType: 'image/png', size: 1024 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://hub.example.com/agents/a1/api/v1/files');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    const form = calls[0]?.init?.body;
    expect(form).toBeInstanceOf(FormData);
    const part = (form as FormData).get('file');
    expect(part).toBeInstanceOf(File);
    expect((part as File).name).toBe('pasted-1.png');
  });

  it('maps a business-error envelope (e.g. scoped-agent 40302) to EnvelopeError', async () => {
    await expect(
      uploadImage({
        ...ENDPOINT,
        file: new File(['x'], 'x.png', { type: 'image/png' }),
        fileName: 'x.png',
        fetchImpl: async () =>
          jsonResponse({ code: 40302, msg: 'session-scoped agent: file upload is a host surface' }),
      }),
    ).rejects.toMatchObject({ name: 'EnvelopeError', code: 40302 });
  });

  it('rejects malformed success bodies', async () => {
    await expect(
      uploadImage({
        ...ENDPOINT,
        file: new File(['x'], 'x.png', { type: 'image/png' }),
        fileName: 'x.png',
        fetchImpl: async () => jsonResponse({ code: 0, msg: 'ok', data: { nope: true } }),
      }),
    ).rejects.toThrow('unexpected response shape');
  });
});

describe('buildImagePreviewUrl / revokePreviewUrl', () => {
  it('fetches the bytes with the bearer header and returns an object URL', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const url = await buildImagePreviewUrl({
      ...ENDPOINT,
      fileId: 'f-1',
      createObjectUrl: () => 'blob:mock-1',
      fetchImpl: async (input, init) => {
        seen.push({
          url: requestUrl(input),
          headers: init?.headers as Record<string, string>,
        });
        return new Response(new Blob(['png-bytes'], { type: 'image/png' }));
      },
    });
    expect(url).toBe('blob:mock-1');
    expect(seen[0]?.url).toBe('http://hub.example.com/agents/a1/api/v1/files/f-1');
    expect(seen[0]?.headers?.['authorization']).toBe('Bearer tok');
  });

  it('revoke pairs with create (and an empty url is a no-op)', () => {
    const revoked: string[] = [];
    revokePreviewUrl('blob:mock-1', (u) => revoked.push(u));
    revokePreviewUrl('', (u) => revoked.push(u));
    expect(revoked).toEqual(['blob:mock-1']);
  });

  it('surfaces transport errors', async () => {
    await expect(
      buildImagePreviewUrl({
        ...ENDPOINT,
        fileId: 'gone',
        createObjectUrl: () => 'blob:x',
        fetchImpl: async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
      }),
    ).rejects.toThrow('http 404');
  });
});

describe('buildPromptContent', () => {
  const images = [{ id: 'f-1', name: 'a.png', mediaType: 'image/png', size: 1 }];

  it('orders image parts first, text last', () => {
    expect(buildPromptContent('caption', images)).toEqual([
      { type: 'image', source: { kind: 'file', file_id: 'f-1' } },
      { type: 'text', text: 'caption' },
    ]);
  });

  it('an empty caption leaves image parts only', () => {
    expect(buildPromptContent('', images)).toEqual([
      { type: 'image', source: { kind: 'file', file_id: 'f-1' } },
    ]);
  });
});

describe('sendPromptWithImages', () => {
  it('posts the multipart content body to /prompts', async () => {
    let body: { content?: unknown } = {};
    const result = await sendPromptWithImages({
      ...ENDPOINT,
      sessionId: 's1',
      text: 'look',
      images: [{ id: 'f-9', name: 'x.png', mediaType: 'image/png', size: 1 }],
      fetchImpl: async (_url, init) => {
        body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { content?: unknown };
        return jsonResponse({
          code: 0,
          msg: 'ok',
          data: { prompt_id: 'p1', status: 'queued' },
        });
      },
    });
    expect(result).toEqual({ promptId: 'p1', status: 'queued' });
    expect(body.content).toEqual([
      { type: 'image', source: { kind: 'file', file_id: 'f-9' } },
      { type: 'text', text: 'look' },
    ]);
  });
});

// ------------------------------------------------------------------ reducer

function chip(localId: string, extra?: Partial<ComposerAttachment>): ComposerAttachment {
  return {
    localId,
    name: `${localId}.png`,
    size: 100,
    mediaType: 'image/png',
    file: new File(['x'], `${localId}.png`, { type: 'image/png' }),
    status: 'uploading',
    ...extra,
  };
}

describe('composerAttachmentsReducer', () => {
  it('adds, resolves to ready with the file id, and fails with the error', () => {
    let state: readonly ComposerAttachment[] = [];
    state = composerAttachmentsReducer(state, { type: 'add', attachment: chip('a') });
    state = composerAttachmentsReducer(state, { type: 'resolve', localId: 'a', fileId: 'f-1' });
    expect(state[0]).toMatchObject({ status: 'ready', fileId: 'f-1' });
    state = composerAttachmentsReducer(state, { type: 'fail', localId: 'a', error: 'boom' });
    expect(state[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('retry returns a failed chip to uploading and clears the error', () => {
    let state: readonly ComposerAttachment[] = [chip('a', { status: 'failed', error: 'boom' })];
    state = composerAttachmentsReducer(state, { type: 'retry', localId: 'a' });
    expect(state[0]).toMatchObject({ status: 'uploading', error: undefined });
  });

  it('remove drops the chip; unknown ids keep the state identity', () => {
    let state: readonly ComposerAttachment[] = [chip('a'), chip('b')];
    state = composerAttachmentsReducer(state, { type: 'remove', localId: 'a' });
    expect(state.map((a) => a.localId)).toEqual(['b']);
    expect(composerAttachmentsReducer(state, { type: 'remove', localId: 'zzz' })).toBe(state);
  });

  it('preview attaches the object URL', () => {
    let state: readonly ComposerAttachment[] = [chip('a', { status: 'ready', fileId: 'f-1' })];
    state = composerAttachmentsReducer(state, { type: 'preview', localId: 'a', previewUrl: 'blob:1' });
    expect(state[0]?.previewUrl).toBe('blob:1');
  });

  it('readyAttachments keeps chip order and skips non-ready chips', () => {
    const state: readonly ComposerAttachment[] = [
      chip('a', { status: 'ready', fileId: 'f-1' }),
      chip('b'),
      chip('c', { status: 'ready', fileId: 'f-3' }),
      chip('d', { status: 'failed', error: 'x' }),
    ];
    expect(readyAttachments(state).map((i) => i.id)).toEqual(['f-1', 'f-3']);
    for (const a of state.filter((x) => x.status === 'ready')) {
      expect(a.fileId).toBeDefined();
    }
  });

  it('clear empties (send success path)', () => {
    const state: readonly ComposerAttachment[] = [chip('a')];
    expect(composerAttachmentsReducer(state, { type: 'clear' })).toEqual([]);
  });
});

describe('EnvelopeError reuse', () => {
  it('the upload path throws the shared envelope error class', async () => {
    const spy = vi.fn(async () => jsonResponse({ code: 40101, msg: 'unauthorized' }, 200));
    await expect(
      uploadImage({ ...ENDPOINT, file: new File(['x'], 'x.png'), fileName: 'x.png', fetchImpl: spy }),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });
});
