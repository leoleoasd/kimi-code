/**
 * REST client for the kap-server pending-interaction surface (approvals +
 * questions), tunneled through the hub per agent:
 *
 *   GET  /api/v1/sessions/{sid}/approvals?status=pending
 *   POST /api/v1/sessions/{sid}/approvals/{approval_id}      { decision, feedback? }
 *   GET  /api/v1/sessions/{sid}/questions?status=pending
 *   POST /api/v1/sessions/{sid}/questions/{question_id}      { answers: { [qid]: answer } }
 *   POST /api/v1/sessions/{sid}/questions/{question_id}:dismiss
 *
 * Wire shapes mirror `packages/kap-server/src/protocol/{approval,question}.ts`,
 * hand-validated (no zod here). Question item/option ids are the server's
 * synthesized `q_<idx>` / `opt_<q>_<o>` strings — opaque to this client.
 *
 * Two success codes are non-zero on purpose (idempotent outcomes):
 *   - resolve: code 0; a replay answers 40902 "already resolved"
 *   - dismiss: code 40909 "dismissed" with the result IN data
 */

import { getJson, postJson, type HttpEndpoint } from '#/http';

// ----------------------------------------------------------------- approvals

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly toolInputDisplay: unknown;
  readonly createdAt: string;
}

function parseApproval(value: unknown): ApprovalRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const a = value as Record<string, unknown>;
  if (
    typeof a['approval_id'] !== 'string' ||
    typeof a['tool_name'] !== 'string' ||
    typeof a['action'] !== 'string'
  ) {
    return undefined;
  }
  return {
    approvalId: a['approval_id'],
    toolCallId: typeof a['tool_call_id'] === 'string' ? a['tool_call_id'] : '',
    toolName: a['tool_name'],
    action: a['action'],
    toolInputDisplay: a['tool_input_display'],
    createdAt: typeof a['created_at'] === 'string' ? a['created_at'] : '',
  };
}

export async function fetchPendingApprovals(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<readonly ApprovalRequest[]> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/approvals`,
    query: new URLSearchParams({ status: 'pending' }),
  });
  if (data === null || typeof data !== 'object' || !Array.isArray((data as { items?: unknown }).items)) {
    throw new Error('approvals: unexpected response shape');
  }
  return ((data as { items: unknown[] }).items)
    .map(parseApproval)
    .filter((a): a is ApprovalRequest => a !== undefined);
}

export async function resolveApproval(
  endpoint: HttpEndpoint & {
    sessionId: string;
    approvalId: string;
    decision: 'approved' | 'rejected';
    feedback?: string;
  },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/approvals/${encodeURIComponent(endpoint.approvalId)}`,
    body: { decision: endpoint.decision, feedback: endpoint.feedback },
    // 40902 = already resolved (idempotent replay) — the follow-up refetch settles the UI.
    acceptCodes: [0, 40902],
  });
}

// ----------------------------------------------------------------- questions

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
}

export interface QuestionRequest {
  readonly questionId: string;
  readonly questions: readonly QuestionItem[];
  readonly createdAt: string;
}

export type QuestionAnswer =
  | { readonly kind: 'single'; readonly option_id: string }
  | { readonly kind: 'multi'; readonly option_ids: readonly string[] }
  | { readonly kind: 'skipped' };

function parseOption(value: unknown): QuestionOption | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['label'] !== 'string') return undefined;
  return {
    id: o['id'],
    label: o['label'],
    description: typeof o['description'] === 'string' ? o['description'] : undefined,
  };
}

function parseQuestion(value: unknown): QuestionRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const q = value as Record<string, unknown>;
  if (typeof q['question_id'] !== 'string' || !Array.isArray(q['questions'])) return undefined;
  const items = (q['questions'] as unknown[])
    .map((raw): QuestionItem | undefined => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
      const item = raw as Record<string, unknown>;
      if (typeof item['id'] !== 'string' || typeof item['question'] !== 'string') return undefined;
      if (!Array.isArray(item['options'])) return undefined;
      const options = (item['options'] as unknown[])
        .map(parseOption)
        .filter((o): o is QuestionOption => o !== undefined);
      if (options.length === 0) return undefined;
      return {
        id: item['id'],
        question: item['question'],
        header: typeof item['header'] === 'string' ? item['header'] : undefined,
        options,
        multiSelect: item['multi_select'] === true,
      };
    })
    .filter((item): item is QuestionItem => item !== undefined);
  if (items.length === 0) return undefined;
  return {
    questionId: q['question_id'],
    questions: items,
    createdAt: typeof q['created_at'] === 'string' ? q['created_at'] : '',
  };
}

export async function fetchPendingQuestions(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<readonly QuestionRequest[]> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/questions`,
    query: new URLSearchParams({ status: 'pending' }),
  });
  if (data === null || typeof data !== 'object' || !Array.isArray((data as { items?: unknown }).items)) {
    throw new Error('questions: unexpected response shape');
  }
  return ((data as { items: unknown[] }).items)
    .map(parseQuestion)
    .filter((q): q is QuestionRequest => q !== undefined);
}

export async function answerQuestion(
  endpoint: HttpEndpoint & {
    sessionId: string;
    questionId: string;
    answers: Record<string, QuestionAnswer>;
  },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/questions/${encodeURIComponent(endpoint.questionId)}`,
    body: { answers: endpoint.answers },
    acceptCodes: [0, 40902],
  });
}

export async function dismissQuestion(
  endpoint: HttpEndpoint & { sessionId: string; questionId: string },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/questions/${encodeURIComponent(endpoint.questionId)}:dismiss`,
    // 40909 is the endpoint's intentional success code for a dismiss.
    acceptCodes: [0, 40909],
  });
}
