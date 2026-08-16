/**
 * Transparent response compression (br/gzip/deflate) for buffered payloads.
 *
 * Hand-rolled instead of @fastify/compress: v8.3.1's peek/pump stream
 * pipeline yields EMPTY bodies on this stack (fastify 5.8.5 + Node 24.15),
 * and every response here is already a buffered string/Buffer when onSend
 * runs, so a synchronous swap is exact — no stream plumbing.
 *
 * Skip rules: non-buffered payloads (streams), an already-set
 * `content-encoding` (upstream/proxy encoded), any `etag` (an encoded
 * representation would need its own), non-compressible content types, and
 * bodies below {@link COMPRESSION_THRESHOLD}. `content-length` is dropped on
 * encode; fastify re-frames at write time.
 */

import zlib from 'node:zlib';

export const COMPRESSION_THRESHOLD = 1024;

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/;

type NegotiatedEncoding = 'br' | 'gzip' | 'deflate';

/** Parse Accept-Encoding with q-values; first-listed wins ties. */
export function negotiateEncoding(acceptEncoding: string): NegotiatedEncoding | undefined {
  let best: { enc: NegotiatedEncoding; q: number } | undefined;
  for (const part of acceptEncoding.split(',')) {
    const [rawEnc, ...params] = part.trim().split(';');
    const enc = rawEnc!.trim().toLowerCase();
    if (enc !== 'br' && enc !== 'gzip' && enc !== 'deflate') continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key?.trim().toLowerCase() === 'q') q = Number(value) || 0;
    }
    if (q <= 0) continue;
    if (best === undefined || q > best.q) best = { enc: enc as NegotiatedEncoding, q };
  }
  return best?.enc;
}

interface CompressionApp {
  addHook(
    name: 'onSend',
    hook: (
      req: { headers: Record<string, unknown> },
      reply: {
        getHeader(name: string): unknown;
        header(name: string, value: string): unknown;
        removeHeader(name: string): unknown;
      },
      payload: unknown,
      next: (err: Error | null, payload?: unknown) => void,
    ) => void,
  ): unknown;
}

export function installCompression(app: CompressionApp): void {
  // CALLBACK-style, everything synchronous inside: an ASYNC onSend hook
  // combined with a slow onRequest hook (bcrypt verify) + undici's client
  // intermittently triggers fastify's "Reply was already sent" double-write
  // race (repro: slow onRequest + ≥1 async onSend); a synchronous hook never
  // gives the queue a window to race in.
  app.addHook('onSend', (req, reply, payload, next) => {
    const contentTypeHeader = reply.getHeader('content-type');
    const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : 'application/json';
    const acceptEncoding = req.headers['accept-encoding'];
    if (
      (typeof payload !== 'string' && !Buffer.isBuffer(payload)) ||
      reply.getHeader('content-encoding') !== undefined ||
      reply.getHeader('etag') !== undefined ||
      !COMPRESSIBLE.test(contentType) ||
      Buffer.byteLength(payload) < COMPRESSION_THRESHOLD ||
      typeof acceptEncoding !== 'string'
    ) {
      next(null, payload);
      return;
    }

    const encoding = negotiateEncoding(acceptEncoding);
    if (encoding === undefined) {
      next(null, payload);
      return;
    }

    reply.header('content-encoding', encoding);
    reply.header('vary', 'accept-encoding');
    reply.removeHeader('content-length');
    switch (encoding) {
      case 'br':
        // Quality 4: the default (11) crawls on multi-KB JSON payloads.
        next(
          null,
          zlib.brotliCompressSync(payload, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
          }),
        );
        return;
      case 'gzip':
        next(null, zlib.gzipSync(payload));
        return;
      case 'deflate':
        next(null, zlib.deflateSync(payload));
        return;
    }
  });
}
