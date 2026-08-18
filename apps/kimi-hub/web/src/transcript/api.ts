/**
 * REST client for the transcript endpoints of one agent (through the hub):
 *
 *   GET /api/v1/sessions/{sid}/transcript?agent_id&page_size&before_turn
 *   GET /api/v1/sessions/{sid}/transcript/ops?agent_id&since_seq
 *
 * The page endpoint is the ONLY source of full transcript state: the initial
 * load fetches the newest page, a full refresh re-reads page by page from the
 * tail backwards, and "load earlier" pages further with a `before_turn`
 * cursor (the WS channel carries incremental `transcript.ops` only). The
 * response is validated with the package-owned `transcriptResponseSchema` —
 * the schema is the single source of truth for the wire shape.
 */

import {
  transcriptOpsCatchupResponseSchema,
  transcriptResponseSchema,
  type AgentDescriptor,
  type TranscriptAttachment,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptMeta,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTodo,
} from '@moonshot-ai/transcript';

import type { HttpEndpoint } from '#/http';

/** One transcript page as merged by the chat store. */
export interface TranscriptPage {
  readonly items: readonly TranscriptItem[];
  /** `has_more` in the query direction — more older turns exist. */
  readonly hasMoreOlder: boolean;
  /** Global, unpaginated state (every response carries the current whole). */
  readonly tasks: readonly TranscriptTask[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly todos: readonly TranscriptTodo[];
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: readonly string[];
  /** The session's agent roster (main + subagents), for the per-agent tabs. */
  readonly agents: readonly AgentDescriptor[];
  /** Op-batch watermark (state includes every batch with seq <= N); absent on legacy servers. */
  readonly seq?: number | undefined;
}

/**
 * Turns per REST page: the viewport grows in slices of recent history. Kept
 * SMALL on purpose: a page also caps the payload (tool-output frames run tens
 * of KB each, so 20 turns frequently crossed a megabyte — brutal on a phone
 * link). 10 turns keeps pages quick to fetch, parse, and paint; the 3000px
 * sentinel margin refills well ahead of the scroll edge anyway.
 */
export const TRANSCRIPT_PAGE_SIZE = 10;

export async function fetchTranscriptPage(
  endpoint: HttpEndpoint & {
    sessionId: string;
    agentId: string;
    /** Turn-id cursor; when set, fetches up to `pageSize` segments strictly older. */
    beforeTurn?: string | undefined;
    pageSize?: number | undefined;
  },
): Promise<TranscriptPage> {
  const params = new URLSearchParams({
    agent_id: endpoint.agentId,
    page_size: String(endpoint.pageSize ?? TRANSCRIPT_PAGE_SIZE),
  });
  if (endpoint.beforeTurn !== undefined) params.set('before_turn', endpoint.beforeTurn);
  const headers: Record<string, string> = {};
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const doFetch = endpoint.fetchImpl ?? fetch;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/transcript?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`transcript page failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = transcriptResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('transcript page: unexpected response shape');
  }
  return {
    items: parsed.data.items,
    hasMoreOlder: parsed.data.has_more,
    tasks: parsed.data.tasks,
    interactions: parsed.data.interactions,
    attachments: parsed.data.attachments,
    todos: parsed.data.todos,
    meta: parsed.data.meta,
    pendingInteractions: parsed.data.pending_interactions,
    agents: parsed.data.agents,
    seq: parsed.data.seq,
  };
}

// ---------------------------------------------------------------- ops catch-up

/** One sequenced op batch from the catch-up endpoint. */
export interface TranscriptOpBatch {
  readonly seq: number;
  readonly ops: readonly TranscriptOperation[];
}

export interface TranscriptOpsCatchup {
  readonly batches: readonly TranscriptOpBatch[];
  readonly latestSeq: number;
  /** False = the journal cannot cover `sinceSeq`; the caller must full-refresh. */
  readonly complete: boolean;
}

/**
 * Point-to-point catch-up: `GET .../transcript/ops?agent_id=&since_seq=N`.
 * Available on sequenced servers; a 404/envelope error means the server
 * predates the endpoint and the caller should fall back to a full refresh.
 */
export async function fetchTranscriptOps(
  endpoint: HttpEndpoint & {
    sessionId: string;
    agentId: string;
    /** Return journaled batches with seq strictly greater than this watermark. */
    sinceSeq: number;
  },
): Promise<TranscriptOpsCatchup> {
  const params = new URLSearchParams({
    agent_id: endpoint.agentId,
    since_seq: String(endpoint.sinceSeq),
  });
  const headers: Record<string, string> = {};
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const doFetch = endpoint.fetchImpl ?? fetch;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/transcript/ops?${params.toString()}`,
    { headers },
  );
  const envelope = (await res.json()) as { code: number; msg: string; data: unknown };
  if (envelope.code !== 0) {
    throw new Error(`transcript ops failed (${envelope.code}): ${envelope.msg}`);
  }
  const parsed = transcriptOpsCatchupResponseSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new Error('transcript ops: unexpected response shape');
  }
  return {
    batches: parsed.data.batches,
    latestSeq: parsed.data.latest_seq,
    complete: parsed.data.complete,
  };
}
