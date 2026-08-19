
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
