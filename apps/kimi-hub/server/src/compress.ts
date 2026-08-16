/**
 * Transparent response compression at the browser-facing edge
 * (br/gzip/deflate). The hub re-encodes for the browser whatever comes out
 * of the tunnel as identity — the connector's undici fetch decompresses any
 * upstream (kap-server) encoding and strips its header, so relayed bodies
 * always arrive plain.
 *
 * Keep in sync with packages/kap-server/src/middleware/compression.ts —
 * hand-rolled for the same reason (the @fastify/compress v8 stream pipeline
 * yields empty bodies on this stack; hub payloads are all buffered).
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
