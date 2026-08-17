/**
 * REST client for the kap-server session surface, tunneled through the hub:
 * every helper takes an agent's proxy base (`${hubOrigin}/agents/{agentId}`)
 * and the hub token, and speaks the unchanged production protocol —
 *
 *   GET  /api/v2/sessions?sort&page_size&page_token   (domain session list)
 *   POST /api/v1/sessions                             (create; cwd in metadata)
 *   GET  /api/v1/sessions/{sid}                       (one session — rail title)
 *   GET  /api/v1/sessions/{sid}/status                (busy/idle + context)
 *   POST /api/v1/sessions/{sid}:abort                 (cancel the active turn)
 *   GET  /api/v1/sessions/{sid}/commands              (the agent's slash-command catalog)
 *   POST /api/v1/sessions/{sid}:command               (run one composer line in the agent's dispatch)
 *   POST /api/v1/sessions/{sid}:compact               (fold the prefix; body { instruction? })
 *   POST /api/v1/sessions/{sid}:undo                  (drop the last N turns; body { count? })
 *   POST /api/v1/sessions/{sid}:fork                  (copy the session; data is the NEW session)
 *   POST /api/v1/sessions/{sid}:btw                   (start a side-channel agent; data { agent_id })
 *   POST /api/v1/sessions/{sid}/skills/{name}:activate (data { activated: true, skill_name })
 *   POST /api/v1/sessions/{sid}/export                (zip BYTES, no envelope on success)
 *   POST /api/v1/sessions/{sid}/prompts               (submit; server queues)
 *   GET  /api/v1/sessions/{sid}/prompts               ({ active, queued } — the engine-owned FIFO)
 *   POST /api/v1/sessions/{sid}/prompts/{pid}:abort   (drop one prompt; 40903 = already done)
 *
 * Hand-validated like the hub client: malformed list entries are dropped,
 * malformed bodies throw. Wire fields are camelCase in v2 (`meta.updated_at`
 * is the query key but the item shape itself is already grouped).
 */

import { EnvelopeError, getJson, postJson, type HttpEndpoint } from '#/http';

// ------------------------------------------------------------------ v2 list

export type SessionActivityStatus = 'running' | 'approval' | 'question' | 'failed' | 'idle';

export interface SessionSummary {
  readonly id: string;
  readonly workspace: { readonly id: string; readonly cwd: string | null };
  readonly meta: {
    readonly title: string | null;
    readonly lastPrompt: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived: boolean;
  };
  readonly activity: { readonly status: SessionActivityStatus };
}

const ACTIVITY_STATUSES = new Set<SessionActivityStatus>([
  'running',
  'approval',
  'question',
  'failed',
  'idle',
]);

function parseSession(value: unknown): SessionSummary | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  const workspace = s['workspace'] as Record<string, unknown> | null;
  const meta = s['meta'] as Record<string, unknown> | null;
  const activity = s['activity'] as Record<string, unknown> | null;
  if (
    typeof s['id'] !== 'string' ||
    workspace === null ||
    typeof workspace !== 'object' ||
    typeof workspace['id'] !== 'string' ||
    meta === null ||
    typeof meta !== 'object' ||
    typeof meta['created_at'] !== 'number' ||
    typeof meta['updated_at'] !== 'number' ||
    typeof meta['archived'] !== 'boolean' ||
    activity === null ||
    typeof activity !== 'object' ||
    typeof activity['status'] !== 'string' ||
    !ACTIVITY_STATUSES.has(activity['status'] as SessionActivityStatus)
  ) {
    return undefined;
  }
  const cwd = workspace['cwd'];
  const title = meta['title'];
  const lastPrompt = meta['last_prompt'];
  return {
    id: s['id'],
    workspace: { id: workspace['id'], cwd: typeof cwd === 'string' ? cwd : null },
    meta: {
      title: typeof title === 'string' ? title : null,
      lastPrompt: typeof lastPrompt === 'string' ? lastPrompt : null,
      createdAt: meta['created_at'],
      updatedAt: meta['updated_at'],
      archived: meta['archived'],
    },
    activity: { status: activity['status'] as SessionActivityStatus },
  };
}

/**
 * List the agent's non-archived sessions, most recently active first. Paging
 * is folded in: one request with a generous `page_size` is enough for the
 * rail (the v2 cursor's conditions must stay stable mid-pagination, so we
 * simply do not keep a cursor around).
 */
export async function fetchSessions(endpoint: HttpEndpoint): Promise<readonly SessionSummary[]> {
  const data = await getJson({
    ...endpoint,
    path: '/api/v2/sessions',
    query: new URLSearchParams({
      'meta.archived': 'false',
      sort: 'meta.updated_at_desc',
      page_size: '100',
    }),
  });
  if (data === null || typeof data !== 'object' || !Array.isArray((data as { items?: unknown }).items)) {
    throw new Error('sessions: unexpected response shape');
  }
  return ((data as { items: unknown[] }).items)
    .map(parseSession)
    .filter((s): s is SessionSummary => s !== undefined);
}

// ------------------------------------------------------------------ create

export interface CreatedSession {
  readonly id: string;
  readonly title: string;
}

/**
 * Create a session on the agent machine. `cwd` is an ABSOLUTE path on the
 * agent (the hub never touches agent-local paths itself).
 */
export async function createSession(
  endpoint: HttpEndpoint & { cwd: string; title?: string },
): Promise<CreatedSession> {
  const data = await postJson({
    ...endpoint,
    path: '/api/v1/sessions',
    body: {
      title: endpoint.title !== undefined && endpoint.title !== '' ? endpoint.title : undefined,
      metadata: { cwd: endpoint.cwd },
    },
  });
  const s = (data ?? {}) as Record<string, unknown>;
  if (typeof s['id'] !== 'string') throw new Error('create session: unexpected response shape');
  return { id: s['id'], title: typeof s['title'] === 'string' ? s['title'] : '' };
}

// ------------------------------------------------------------------ get one

export interface SessionInfo {
  readonly id: string;
  readonly title: string | null;
  readonly lastPrompt: string | null;
}

/**
 * The react-query key every `fetchSession` result lives under — the rail's
 * lazy title rows AND the open chat's header share it, so one
 * `invalidateQueries` (e.g. on a `session.meta.updated` WS frame) refreshes
 * every mounted observer of that (agent, session) pair.
 */
export function sessionInfoQueryKey(baseUrl: string, sessionId: string) {
  return ['session-info', baseUrl, sessionId] as const;
}

/**
 * Fetch one session — the rail's lazy title lookup for scoped entries (the
 * scope only carries ids). Wire `title`/`last_prompt` empty strings read as
 * absent so the caller can fall back to the shortened id.
 */
export async function fetchSession(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<SessionInfo> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}`,
  });
  const s = (data ?? {}) as Record<string, unknown>;
  if (typeof s['id'] !== 'string') throw new Error('session: unexpected response shape');
  const title = s['title'];
  const lastPrompt = s['last_prompt'];
  return {
    id: s['id'],
    title: typeof title === 'string' && title !== '' ? title : null,
    lastPrompt: typeof lastPrompt === 'string' && lastPrompt !== '' ? lastPrompt : null,
  };
}

// ------------------------------------------------------------------ plans

/**
 * One ExitPlanMode call's plan content, projected by the server's
 * `GET /api/v1/sessions/{sid}/transcript/plan` route — recovered from the
 * approval interaction, the live tool-frame display, or the output text, in
 * timeline order. The transcript's `plan.revision` MARKERS carry only blob
 * references, so marker rows pair with these entries for the rendered plan.
 */
export interface SessionPlanEntry {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly source: 'interaction' | 'display' | 'output';
  readonly plan: string;
  readonly path?: string;
}

function parsePlanEntry(value: unknown): SessionPlanEntry | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const e = value as Record<string, unknown>;
  const source = e['source'];
  if (
    typeof e['tool_call_id'] !== 'string' ||
    typeof e['turn_id'] !== 'string' ||
    (source !== 'interaction' && source !== 'display' && source !== 'output') ||
    typeof e['plan'] !== 'string'
  ) {
    return undefined;
  }
  return {
    toolCallId: e['tool_call_id'],
    turnId: e['turn_id'],
    source,
    plan: e['plan'],
    path: typeof e['path'] === 'string' ? e['path'] : undefined,
  };
}

export async function fetchSessionPlans(
  endpoint: HttpEndpoint & { sessionId: string; agentId: string },
): Promise<readonly SessionPlanEntry[]> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/transcript/plan?agent_id=${encodeURIComponent(endpoint.agentId)}`,
  });
  const d = (data ?? {}) as Record<string, unknown>;
  const raw = d['plans'];
  if (!Array.isArray(raw)) throw new Error('session plans: unexpected response shape');
  return raw.map(parsePlanEntry).filter((e): e is SessionPlanEntry => e !== undefined);
}

// ------------------------------------------------------------------ status

export interface SessionStatus {
  readonly busy: boolean;
  readonly model?: string;
  /** The model's effective thinking effort ('off'/'on'/'high'/…); '' on the wire (no model bound) reads as absent. */
  readonly thinkingLevel?: string;
  readonly permission?: string;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly contextTokens: number;
  readonly maxContextTokens?: number;
  /** 0..1 */
  readonly contextUsage: number;
}

export async function fetchSessionStatus(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<SessionStatus> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/status`,
  });
  const s = (data ?? {}) as Record<string, unknown>;
  if (typeof s['busy'] !== 'boolean') throw new Error('session status: unexpected response shape');
  const thinkingLevel = s['thinking_level'];
  return {
    busy: s['busy'],
    model: typeof s['model'] === 'string' ? s['model'] : undefined,
    thinkingLevel:
      typeof thinkingLevel === 'string' && thinkingLevel !== '' ? thinkingLevel : undefined,
    permission: typeof s['permission'] === 'string' ? s['permission'] : undefined,
    planMode: s['plan_mode'] === true ? true : undefined,
    swarmMode: s['swarm_mode'] === true ? true : undefined,
    contextTokens: typeof s['context_tokens'] === 'number' ? s['context_tokens'] : 0,
    maxContextTokens:
      typeof s['max_context_tokens'] === 'number' ? s['max_context_tokens'] : undefined,
    contextUsage: typeof s['context_usage'] === 'number' ? s['context_usage'] : 0,
  };
}

/** Cancel whatever turn is active; a safe no-op when the session is idle. */
export async function abortSession(endpoint: HttpEndpoint & { sessionId: string }): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}:abort`,
  });
}

// ------------------------------------------------------------------ model catalog

/**
 * One selectable model from the agent's configured catalog (`GET
 * /api/v1/models`). `id` is the catalog alias — the same string `GET
 * …/status` reports as the session's current model and
 * `POST …/profile {agent_config:{model}}` takes.
 */
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  /** Raw capability strings ('thinking' / 'always_thinking' / …) — the effort segments derive from these. */
  readonly capabilities?: readonly string[];
  /** Declared effort levels (e.g. ['low','high']); absent → the legacy on/off model. */
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function parseModelChoice(value: unknown): ModelChoice | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  const provider = m['provider'];
  const alias = m['model'];
  if (typeof provider !== 'string' || typeof alias !== 'string') return undefined;
  const display =
    typeof m['display_name'] === 'string' && m['display_name'] !== ''
      ? m['display_name']
      : undefined;
  // Two aliases can share one display name (k3-gw / k3-b300 are both
  // "kimi-k3"); the label keeps the alias visible so they stay tellable.
  const label =
    display === undefined || display === alias
      ? `${alias} · ${provider}`
      : `${display} (${alias} · ${provider})`;
  return {
    id: alias,
    label,
    provider,
    capabilities: stringList(m['capabilities']),
    supportEfforts: stringList(m['support_efforts']),
    defaultEffort: typeof m['default_effort'] === 'string' ? m['default_effort'] : undefined,
  };
}

/** The agent-wide model catalog the header picker offers. */
export async function fetchModels(endpoint: HttpEndpoint): Promise<readonly ModelChoice[]> {
  const data = await getJson({ ...endpoint, path: '/api/v1/models' });
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d['items'])) throw new Error('models: unexpected response shape');
  return (d['items'] as unknown[]).map(parseModelChoice).filter((m): m is ModelChoice => m !== undefined);
}

/**
 * Switch the session's main agent to a catalog alias — persists at the engine
 * profile. An optional `thinking` effort rides the SAME write: the server
 * applies model first, then validates the effort against the NEW model
 * (sessionAgentConfig.ts), so an effort the new model rejects fails the whole
 * request with the model already bound.
 */
export async function setSessionModel(
  endpoint: HttpEndpoint & { sessionId: string; model: string; thinking?: string },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/profile`,
    body: { agent_config: { model: endpoint.model, thinking: endpoint.thinking } },
  });
}

// ---------------------------------------------------------------- commands

/** One row of the agent's slash-command catalog (`GET …/commands`; bridge-provided). */
export interface SessionCommandInfo {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly usage: string;
  readonly description?: string;
}

/**
 * Commands that open an INTERACTIVE dialog on the host TUI's screen (a picker
 * overlay, not a line of output). The hub page can neither render nor drive
 * those — they're dropped from the hint catalog, and `parseComposerCommand`
 * short-circuits them locally with a pointer at the native control
 * (`model` has the composer's ModelPicker popup and the header dropdown).
 * Add a name here whenever a bridged command turns out to be dialog-only on
 * the host.
 */
export const DIALOG_COMMANDS: ReadonlySet<string> = new Set(['model']);

/**
 * The commands the agent exposes — the connected TUI's registry when bridged,
 * an empty list for headless agents. Malformed entries are dropped, like the
 * session list.
 */
export async function fetchSessionCommands(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<readonly SessionCommandInfo[]> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/commands`,
  });
  const c = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(c['commands'])) throw new Error('commands: unexpected response shape');
  return (c['commands'] as unknown[])
    .map(parseCommandInfo)
    .filter((row): row is SessionCommandInfo => row !== undefined && !DIALOG_COMMANDS.has(row.name));
}

function parseCommandInfo(value: unknown): SessionCommandInfo | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row['name'] !== 'string' ||
    !Array.isArray(row['aliases']) ||
    !(row['aliases'] as unknown[]).every((a) => typeof a === 'string') ||
    typeof row['usage'] !== 'string'
  ) {
    return undefined;
  }
  const description = row['description'];
  return {
    name: row['name'],
    aliases: row['aliases'] as string[],
    usage: row['usage'],
    description: typeof description === 'string' ? description : undefined,
  };
}

export interface SessionCommandResult {
  readonly notices: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Forward one composer line (`/yolo on`, `/compact …`) to the agent's command
 * bridge — the connected TUI's OWN dispatch executes it; the returned lines
 * are what its notice/error surfaces showed.
 */
export async function runSessionCommand(
  endpoint: HttpEndpoint & { sessionId: string; input: string },
): Promise<SessionCommandResult> {
  const data = await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}:command`,
    body: { input: endpoint.input },
  });
  const r = (data ?? {}) as Record<string, unknown>;
  const toLines = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : [];
  return { notices: toLines(r['notices']), errors: toLines(r['errors']) };
}

/**
 * Fold the conversation prefix into a compaction summary; an optional
 * free-text instruction steers the fold (a blank/absent one runs plain).
 */
export async function compactSession(
  endpoint: HttpEndpoint & { sessionId: string; instruction?: string },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}:compact`,
    body: { instruction: endpoint.instruction },
  });
}

/** Drop the last `count` conversation turns back to a user prompt (server default: 1). */
export async function undoSession(
  endpoint: HttpEndpoint & { sessionId: string; count?: number },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}:undo`,
    body: { count: endpoint.count },
  });
}

/**
 * Fork the session — the response data is the NEW session's wire shape
 * (`forkSessionResponseSchema` in kap-server's rest-session.ts); only its id
 * is consumed here.
 */
export async function forkSession(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<{ readonly id: string }> {
  const data = await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}:fork`,
  });
  const s = (data ?? {}) as Record<string, unknown>;
  if (typeof s['id'] !== 'string') throw new Error('fork session: unexpected response shape');
  return { id: s['id'] };
}

/**
 * Start a `/btw` side-channel agent — data is `startBtwSessionResponseSchema`
 * (`{ agent_id }`). The transcript roster surfaces the new agent on its next
 * sync; nothing auto-switches to it.
 */
export async function btwSession(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<{ readonly agentId: string }> {
  const data = await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}:btw`,
  });
  const s = (data ?? {}) as Record<string, unknown>;
  if (typeof s['agent_id'] !== 'string') throw new Error('btw session: unexpected response shape');
  return { agentId: s['agent_id'] };
}

/**
 * Activate a skill in the session — data is `activateSkillResultSchema`
 * (`{ activated: true, skill_name }`); the engine runs the activation turn
 * itself, progress follows on the transcript stream.
 */
export async function activateSkill(
  endpoint: HttpEndpoint & { sessionId: string; name: string },
): Promise<{ readonly skillName: string }> {
  const data = await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/skills/${encodeURIComponent(endpoint.name)}:activate`,
  });
  const s = (data ?? {}) as Record<string, unknown>;
  if (s['activated'] !== true || typeof s['skill_name'] !== 'string') {
    throw new Error('activate skill: unexpected response shape');
  }
  return { skillName: s['skill_name'] };
}

/**
 * Stream the session diagnostic archive as a Blob. Unlike every other helper
 * here the SUCCESS body is raw zip bytes (no envelope) — failures still come
 * back as the standard JSON envelope (e.g. `session export exceeds the
 * 64 MiB web limit`), which is unwrapped onto the shared error classes —
 * the one non-JSON success path mirrors `files.ts`'s multipart precedent.
 */
export async function exportSession(
  endpoint: HttpEndpoint & { sessionId: string },
): Promise<Blob> {
  const doFetch = endpoint.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.token !== '') headers['authorization'] = `Bearer ${endpoint.token}`;
  const res = await doFetch(
    `${endpoint.baseUrl}/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/export`,
    { method: 'POST', headers, body: JSON.stringify({}) },
  );
  if (res.status === 401) {
    throw new EnvelopeError(40101, 'unauthorized — check the hub token');
  }
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const envelope = (await res.json()) as { code?: unknown; msg?: unknown };
    const code = typeof envelope.code === 'number' ? envelope.code : -1;
    const msg =
      typeof envelope.msg === 'string' && envelope.msg !== '' ? envelope.msg : 'request failed';
    throw new EnvelopeError(code, msg);
  }
  if (!res.ok) {
    throw new Error(`http ${res.status}: ${res.statusText}`);
  }
  return res.blob();
}

// ------------------------------------------------------------------ prompts

export interface PromptSubmitResult {
  readonly promptId: string;
  readonly status: 'running' | 'queued' | 'blocked';
}

/**
 * The `/goal` extras ride the SAME submission (rest-prompt.ts `goal_objective`
 * / `goal_control`) — plain passthrough fields; omitted keys never serialize.
 */
export async function sendPrompt(
  endpoint: HttpEndpoint & {
    sessionId: string;
    text: string;
    goal_objective?: string;
    goal_control?: unknown;
  },
): Promise<PromptSubmitResult> {
  const data = await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/prompts`,
    body: {
      content: [{ type: 'text', text: endpoint.text }],
      goal_objective: endpoint.goal_objective,
      goal_control: endpoint.goal_control,
    },
  });
  const p = (data ?? {}) as Record<string, unknown>;
  if (typeof p['prompt_id'] !== 'string' || typeof p['status'] !== 'string') {
    throw new TypeError('prompt submit: unexpected response shape');
  }
  return { promptId: p['prompt_id'], status: p['status'] as PromptSubmitResult['status'] };
}

// ------------------------------------------------------------- prompt queue

export interface PromptQueueItem {
  readonly promptId: string;
  readonly status: 'running' | 'queued' | 'blocked';
  /** Text parts joined with a space — the strip's snippet source; '' for media-only prompts. */
  readonly text: string;
}

/**
 * The engine's own queue snapshot — the hub never stores queue state. `active`
 * is the in-flight turn's prompt (null when idle), `queued` the FIFO in
 * server order. Wire shape: `promptListResponseSchema` in kap-server's
 * rest-prompt.ts.
 */
export interface PromptQueue {
  readonly active: PromptQueueItem | null;
  readonly queued: readonly PromptQueueItem[];
}

const PROMPT_QUEUE_STATUSES = new Set<string>(['running', 'queued', 'blocked']);

function promptItemText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) continue;
    const p = part as Record<string, unknown>;
    if (p['type'] === 'text' && typeof p['text'] === 'string') texts.push(p['text']);
  }
  return texts.join(' ');
}

function parsePromptQueueItem(value: unknown): PromptQueueItem | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Record<string, unknown>;
  const status = p['status'];
  if (
    typeof p['prompt_id'] !== 'string' ||
    typeof status !== 'string' ||
    !PROMPT_QUEUE_STATUSES.has(status)
  ) {
    return undefined;
  }
  return {
    promptId: p['prompt_id'],
    status: status as PromptQueueItem['status'],
    text: promptItemText(p['content']),
  };
}

export async function fetchPromptQueue(
  endpoint: HttpEndpoint & { sessionId: string; agentId?: string },
): Promise<PromptQueue> {
  const data = await getJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/prompts${
      endpoint.agentId === undefined ? '' : `?agent_id=${encodeURIComponent(endpoint.agentId)}`
    }`,
  });
  const p = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(p['queued'])) throw new Error('prompt queue: unexpected response shape');
  const active = p['active'];
  return {
    active:
      active === null || active === undefined ? null : (parsePromptQueueItem(active) ?? null),
    queued: (p['queued'] as unknown[])
      .map(parsePromptQueueItem)
      .filter((item): item is PromptQueueItem => item !== undefined),
  };
}

/**
 * Abort one prompt by id — the queued-row ✕. The `40903`
 * (prompt.already_completed) reply carries `data: { aborted: false }`: the
 * prompt resolved between the last poll and this call, which is exactly the
 * desired end state — accepted as a no-op success, like `:dismiss`'s 40909.
 * `agentId` targets the queue the prompt sits on (queues are per agent).
 */
export async function abortQueuedPrompt(
  endpoint: HttpEndpoint & { sessionId: string; promptId: string; agentId?: string },
): Promise<void> {
  await postJson({
    ...endpoint,
    path: `/api/v1/sessions/${encodeURIComponent(endpoint.sessionId)}/prompts/${encodeURIComponent(endpoint.promptId)}:abort${
      endpoint.agentId === undefined ? '' : `?agent_id=${encodeURIComponent(endpoint.agentId)}`
    }`,
    acceptCodes: [0, 40903],
  });
}
