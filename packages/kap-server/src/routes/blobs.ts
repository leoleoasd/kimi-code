/**
 * `/api/v1` blob routes — serve dehydrated `blobref:` payloads.
 *
 *   GET /sessions/{session_id}/agents/{agent_id}/blobs/{sha256}
 *
 * Large prompt-media bodies are offloaded into the agent-scoped blob store at
 * persistence (`IAgentBlobService`, key = content sha256); transcript
 * attachments reference them as `{kind:'blob', ref:'blobref:<mime>;<sha256>'}`
 * and a client turns the ref into this URL. The read goes through
 * `TranscriptService.readAgentBlob` (index-resolved, session cold or live —
 * never a live-only store's memory) and answers RAW bytes with
 * `Content-Type: application/octet-stream` (browsers sniff images inside
 * `<img>`); a missing blob answers a real HTTP 404 (40407 envelope body).
 * Unlike the envelope-only transcript family, the HTTP status carries the
 * outcome because the consumers are `<img>` / `fetch`, not envelope readers.
 */

import { isPlainAgentId } from '@moonshot-ai/transcript';
import { z } from 'zod';

import { errEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { defineRoute } from '../middleware/defineRoute';
import type { TranscriptService } from '../services/transcript/transcriptService';

interface BlobRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: BlobReply,
    ) => Promise<void> | void,
  ): unknown;
}

interface BlobReply {
  type(mime: string): BlobReply;
  header(name: string, value: string | number): BlobReply;
  code(status: number): BlobReply;
  send(payload: unknown): unknown;
}

const blobParamSchema = z
  .object({
    session_id: z.string().min(1),
    agent_id: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be a 64-char lowercase hex digest'),
  })
  .superRefine((value, ctx) => {
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const validationDetailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerBlobRoutes(
  app: BlobRouteHost,
  deps: { transcriptService: TranscriptService },
): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/agents/{agent_id}/blobs/{sha256}',
      params: blobParamSchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema: validationDetailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FILE_NOT_FOUND]: {},
      },
      description:
        'Download one dehydrated blobref payload (a large prompt-media body offloaded into the agent-scoped blob store at persistence) by its sha256, as raw application/octet-stream bytes. Works for cold sessions (resolved through the session index, straight from the blob store). 404: 40401 unknown session, 40407 unknown hash',
      tags: ['transcript'],
    },
    async (req, reply) => {
      const { session_id, agent_id, sha256 } = req.params;
      const r = reply as unknown as BlobReply;
      const result = await deps.transcriptService.readAgentBlob(session_id, agent_id, sha256);
      if (result.status === 'session_not_found') {
        r.code(404).send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session not found: ${session_id}`, req.id));
        return;
      }
      if (result.status === 'not_found') {
        r.code(404).send(errEnvelope(ErrorCode.FILE_NOT_FOUND, `blob not found: ${sha256}`, req.id));
        return;
      }
      r.type('application/octet-stream')
        .header('content-length', result.bytes.length)
        .code(200)
        .send(Buffer.from(result.bytes));
    },
  );
  app.get(route.path, route.options, route.handler as unknown as Parameters<BlobRouteHost['get']>[2]);
}
