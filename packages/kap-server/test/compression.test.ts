
import Fastify, { type FastifyInstance } from 'fastify';
import zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installCompression, negotiateEncoding } from '../src/middleware/compression';

const BIG_TEXT = 'x'.repeat(8 * 1024);

describe('negotiateEncoding', () => {
  it('accepts plain encodings and honors q-values', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('gzip');
    expect(negotiateEncoding('br;q=1.0, gzip;q=0.5')).toBe('br');
    expect(negotiateEncoding('gzip;q=0')).toBeUndefined();
    expect(negotiateEncoding('gzip;q=0, br')).toBe('br');
    expect(negotiateEncoding('zstd, identity')).toBeUndefined();
    expect(negotiateEncoding('')).toBeUndefined();
  });
});

describe('installCompression', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    installCompression(app);
    app.get('/big', async () => ({ pad: BIG_TEXT }));
    app.get('/small', async () => ({ ok: true }));
    app.get('/text', async (_req, reply) => reply.type('text/plain').send(BIG_TEXT));
    app.get('/binary', async (_req, reply) =>
      reply.type('application/octet-stream').send(Buffer.from(BIG_TEXT)),
    );
    app.get('/cached', async (_req, reply) =>
      reply.header('etag', '"v1"').type('application/json').send({ pad: BIG_TEXT }),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('gzip-encodes a big JSON body on request and decorates headers', async () => {
    const res = await app.inject({ path: '/big', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toBe('accept-encoding');
    expect(zlib.gunzipSync(res.rawPayload).toString('utf8')).toBe(
      JSON.stringify({ pad: BIG_TEXT }),
    );
  });

  it('prefers br when listed first, quality 4', async () => {
    const res = await app.inject({ path: '/big', headers: { 'accept-encoding': 'br, gzip' } });
    expect(res.headers['content-encoding']).toBe('br');
    expect(zlib.brotliDecompressSync(res.rawPayload).toString('utf8')).toBe(
      JSON.stringify({ pad: BIG_TEXT }),
    );
  });

  it('leaves bodies alone without an acceptable encoding', async () => {
    const res = await app.inject({ path: '/big' });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toEqual({ pad: BIG_TEXT });
  });

  it('does not bother with sub-threshold bodies', async () => {
    const res = await app.inject({ path: '/small', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });

  it('compresses text/* but not application/octet-stream', async () => {
    const text = await app.inject({ path: '/text', headers: { 'accept-encoding': 'deflate' } });
    expect(text.headers['content-encoding']).toBe('deflate');
    expect(zlib.inflateSync(text.rawPayload).toString('utf8')).toBe(BIG_TEXT);

    const bin = await app.inject({ path: '/binary', headers: { 'accept-encoding': 'gzip' } });
    expect(bin.headers['content-encoding']).toBeUndefined();
    expect(bin.rawPayload.toString('utf8')).toBe(BIG_TEXT);
  });

  it('skips responses carrying an etag (their representation is pinned)', async () => {
    const res = await app.inject({ path: '/cached', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['etag']).toBe('"v1"');
    expect(res.json()).toEqual({ pad: BIG_TEXT });
  });
});
