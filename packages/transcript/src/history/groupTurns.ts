import type { AgentTranscriptSnapshot } from '../ops/operation';
import type { TranscriptAttachment } from '../model/attachment';
import type { TranscriptFrame } from '../model/frame';
import type { TranscriptItem, TranscriptMarker } from '../model/item';
import type { TurnOrigin } from '../model/turn';
import { daemonFileRefFromPairingPart } from '../contract/mediaRef';
import { classifyUserText } from './userText';

export type HistoryMediaSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'base64'; readonly media_type: string; readonly data: string }
  | { readonly kind: 'file'; readonly file_id: string };

/**
 * Both persisted media vocabularies: the legacy v1 wire shapes
 * (`image`/`video`/`audio` + `source`, `file` + `file_id`) and the v2 core
 * `ContentPart` shapes (`image_url` / `video_url` with camelCase inner keys,
 * the url being `data:…`, `https://…`, `kimi-file://<id>[?path=…]` (videos),
 * or `blobref:<mime>;<sha256>` for persistence-dehydrated payloads).
 */
export type HistoryContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'think'; readonly think: string }
  | { readonly type: 'image' | 'video' | 'audio'; readonly source: HistoryMediaSource }
  | {
      readonly type: 'file';
      readonly file_id: string;
      readonly name: string;
      readonly media_type: string;
      readonly size: number;
    }
  | { readonly type: 'image_url'; readonly imageUrl: { readonly url: string } }
  | { readonly type: 'video_url'; readonly videoUrl: { readonly url: string } }
  | { readonly type: string };

export interface HistoryToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string | null;
}

export interface HistoryMessage {
  readonly role: string;
  readonly content?: readonly HistoryContentPart[];
  readonly toolCalls?: readonly HistoryToolCall[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly origin?: { readonly kind: string };
  readonly midTurnInject?: boolean;
}

interface TurnDraft {
  turnId: string;
  ordinal: number;
  origin: TurnOrigin;
  prompt?: string;
  attachmentIds?: string[];
  steps: StepDraft[];
}

interface StepDraft {
  stepId: string;
  ordinal: number;
  frames: TranscriptFrame[];
}

const HIDDEN_USER_ORIGINS = new Set(['injection', 'system_trigger', 'retry']);
const TURN_OPENING_SYSTEM_TRIGGERS = new Set(['goal_continuation', 'subagent']);
const MARKER_USER_ORIGINS: Readonly<Record<string, string>> = {
  skill_activation: 'skill',
  plugin_command: 'skill',
  compaction_summary: 'compaction',
};

const FALLBACK_ORIGIN: TurnOrigin = { kind: 'other' };

/**
 * Fold persisted wire messages into a snapshot. When `turnOrdinals` carries at
 * least one engine hint (set only on `turn.prompt` messages), the fold is
 * anchored to the engine's numbering. A hintless user message the reducer
 * flagged `midTurnInject` (queued input steered into a RUNNING engine turn) is
 * folded into the open turn as a trailing user frame, at its chronological
 * step position; a task notification is folded the same way. Every remaining
 * hintless message (shell I/O blocks, cron/hook output, input steered while
 * idle) becomes a "gap turn": its ordinal is
 * the next engine turn's ordinal so the ordinal-ordered insert keeps it ahead
 * of that turn, and its `g<lastEngineOrdinal>.<seq>` id parses numerically so
 * `compareTurnIds` still sorts it strictly between the surrounding `t<N>` ids.
 * Gap turns never mint `t${nextOrdinal}` ids (those collide with engine turns
 * arriving later and upsert over them) and never move the open-turn pointer,
 * so assistant messages following a shell block keep folding into the engine
 * turn it interrupted. Consumers foldFacts and the like pin engine facts and
 * ordinal anchors on `t<ordinal>` ids only. Without hints the legacy
 * sequential numbering is kept.
 */
export function groupMessagesIntoSnapshot(
  messages: readonly HistoryMessage[],
  turnOrdinals?: readonly (number | undefined)[],
): AgentTranscriptSnapshot {
  const items: TranscriptItem[] = [];
  const attachments: TranscriptAttachment[] = [];
  let turn: TurnDraft | undefined;
  let nextOrdinal = 0;
  let markerCount = 0;
  const hasOrdinalHints = turnOrdinals?.some((ordinal) => ordinal !== undefined) ?? false;
  let lastEngineOrdinal = -1;
  let gapCount = 0;

  const gapTurn = (origin: TurnOrigin, prompt?: string, attachmentIds?: string[]): TurnDraft => {
    gapCount += 1;
    const draft: TurnDraft = {
      turnId: `g${lastEngineOrdinal}.${String(gapCount).padStart(6, '0')}`,
      ordinal: lastEngineOrdinal + 1,
      origin,
      prompt,
      attachmentIds,
      steps: [],
    };
    items.push(draftToTurnItem(draft));
    return draft;
  };

  const foldTurnOpeningInput = (
    message: HistoryMessage,
  ): { text: string; attachmentIds?: string[] } => {
    const parts = message.content ?? [];
    const ids: string[] = [];
    const texts: string[] = [];
    for (const part of parts) {
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        texts.push(part.text);
        continue;
      }
      if (part.type === 'image_url' || part.type === 'video_url') {
        if (!('imageUrl' in part || 'videoUrl' in part)) continue;
        const container =
          part.type === 'image_url'
            ? (part.imageUrl as { url: unknown } | undefined)
            : (part.videoUrl as { url: unknown } | undefined);
        const url = container?.url;
        if (typeof url !== 'string' || url.length === 0) continue;
        const family = part.type === 'image_url' ? ('image' as const) : ('video' as const);
        const classified = classifyMediaUrl(url, family);
        if (classified !== undefined) {
          const entity: TranscriptAttachment = {
            attachmentId: `att_${attachments.length + 1}`,
            ...classified,
          };
          attachments.push(entity);
          ids.push(entity.attachmentId);
          continue;
        }
      }
      if (part.type === 'image' || part.type === 'video' || part.type === 'audio') {
        if (!('source' in part) || part.source === undefined) continue;
        const source = part.source as HistoryMediaSource;
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType:
            source.kind === 'base64' ? source.media_type : `${part.type}/*`,
          source:
            source.kind === 'url'
              ? { kind: 'url', url: source.url }
              : source.kind === 'file'
                ? { kind: 'file', fileId: source.file_id }
                : undefined,
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
        continue;
      }
      if (part.type === 'file' && 'file_id' in part) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: part.media_type as string,
          name: part.name as string,
          size: part.size as number,
          source: { kind: 'file', fileId: part.file_id as string },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
        continue;
      }
      const ref = daemonFileRefFromPairingPart(part);
      if (ref !== undefined) {
        const entity: TranscriptAttachment = {
          attachmentId: `att_${attachments.length + 1}`,
          mediaType: `${ref.kind}/*`,
          source: { kind: 'session_media', fileId: ref.ref.fileId },
        };
        attachments.push(entity);
        ids.push(entity.attachmentId);
      }
    }
    return { text: texts.join(''), attachmentIds: ids.length > 0 ? ids : undefined };
  };

  const ensureTurn = (origin: TurnOrigin = FALLBACK_ORIGIN): TurnDraft => {
    if (!turn) {
      if (hasOrdinalHints) {
        turn = gapTurn(origin);
        return turn;
      }
      const ordinal = nextOrdinal;
      nextOrdinal += 1;
      turn = { turnId: `t${ordinal}`, ordinal, origin, steps: [] };
      items.push(draftToTurnItem(turn));
    }
    return turn;
  };

  const startTurn = (
    origin: TurnOrigin,
    prompt?: string,
    attachmentIds?: string[],
    engineOrdinal?: number,
  ): TurnDraft => {
    if (hasOrdinalHints && engineOrdinal === undefined) {
      return gapTurn(origin, prompt, attachmentIds);
    }
    const ordinal = engineOrdinal ?? nextOrdinal;
    nextOrdinal = Math.max(ordinal + 1, nextOrdinal);
    if (engineOrdinal !== undefined) lastEngineOrdinal = engineOrdinal;
    turn = { turnId: `t${ordinal}`, ordinal, origin, prompt, attachmentIds, steps: [] };
    items.push(draftToTurnItem(turn));
    return turn;
  };

  const foldUserFrameIntoTurn = (message: HistoryMessage): void => {
    const classification = classifyUserText(textOf(message));
    if (classification.kind === 'internal') return;
    const current = ensureTurn();
    let step = current.steps.at(-1);
    if (step === undefined) {
      step = {
        stepId: `${current.turnId}.${current.steps.length + 1}`,
        ordinal: current.steps.length + 1,
        frames: [],
      };
      current.steps.push(step);
    }
    const payload = message.origin as { taskId?: unknown } | undefined;
    step.frames.push({
      kind: 'text',
      frameId: `${step.stepId}.f${step.frames.length + 1}`,
      role: 'user',
      text: classification.text,
      ...(typeof payload?.taskId === 'string' ? { taskId: payload.taskId } : {}),
      ...(classification.kind === 'hub' ? { hubFrom: classification.from } : {}),
    });
    syncTurnItem(items, current);
  };

  const pushMarker = (marker: string, payload?: unknown): void => {
    markerCount += 1;
    const item: TranscriptMarker = { kind: 'marker', markerId: `m${markerCount}`, marker, payload };
    items.push(item);
  };

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'system') continue;
    const originKind = message.origin?.kind;
    const engineOrdinal = turnOrdinals?.[messageIndex];

    if (message.role === 'user') {
      if (originKind !== undefined && HIDDEN_USER_ORIGINS.has(originKind)) {
        if (opensOwnTurn(message)) {
          startTurn(mapOrigin(message), undefined, undefined, engineOrdinal);
        }
        continue;
      }
      const markerKey = originKind !== undefined ? MARKER_USER_ORIGINS[originKind] : undefined;
      if (markerKey !== undefined) {
        const opening = isUserSlashPrompt(message) ? foldTurnOpeningInput(message) : undefined;
        pushMarker(markerKey, { text: opening?.text ?? textOf(message), origin: message.origin });
        if (opening !== undefined) {
          startTurn(mapOrigin(message), opening.text, opening.attachmentIds, engineOrdinal);
        }
        continue;
      }
      const bundled = bundledSkillActivations(message);
      if (bundled.length > 0) {
        const parts = message.content ?? [];
        bundled.forEach((activation, index) => {
          const block = parts[index];
          pushMarker('skill', {
            text: block !== undefined && block.type === 'text' && 'text' in block ? block.text : '',
            origin: { kind: 'skill_activation', trigger: 'user-slash', ...activation },
          });
        });
        const callerMessage = { ...message, content: parts.slice(bundled.length) };
        const opening = foldTurnOpeningInput(callerMessage);
        startTurn(mapOrigin(message), opening.text, opening.attachmentIds, engineOrdinal);
        continue;
      }
      if (
        engineOrdinal === undefined &&
        (originKind === 'task' || message.midTurnInject === true)
      ) {
        foldUserFrameIntoTurn(message);
        continue;
      }
      const opening = foldTurnOpeningInput(message);
      const classification = classifyUserText(opening.text);
      if (classification.kind === 'internal') {
        if (opening.attachmentIds !== undefined) {
          startTurn(mapOrigin(message), undefined, opening.attachmentIds, engineOrdinal);
        }
        continue;
      }
      const baseOrigin = mapOrigin(message);
      startTurn(
        classification.kind === 'hub' ? hubTurnOrigin(baseOrigin, classification.from) : baseOrigin,
        classification.text,
        opening.attachmentIds,
        engineOrdinal,
      );
      continue;
    }

    if (message.role === 'assistant') {
      const current = ensureTurn();
      const stepOrdinal = current.steps.length + 1;
      const step: StepDraft = {
        stepId: `${current.turnId}.${stepOrdinal}`,
        ordinal: stepOrdinal,
        frames: [],
      };
      current.steps.push(step);
      let frameCount = 0;
      const nextFrameId = (): string => {
        frameCount += 1;
        return `${step.stepId}.f${frameCount}`;
      };
      for (const part of message.content ?? []) {
        if (part.type === 'text' && 'text' in part && typeof part.text === 'string' && part.text.length > 0) {
          step.frames.push({ kind: 'text', frameId: nextFrameId(), role: 'assistant', text: part.text });
        } else if (part.type === 'think' && 'think' in part && typeof part.think === 'string' && part.think.length > 0) {
          step.frames.push({ kind: 'thinking', frameId: nextFrameId(), text: part.think });
        }
      }
      for (const call of message.toolCalls ?? []) {
        step.frames.push({
          kind: 'tool',
          frameId: `${step.stepId}.${call.id}`,
          toolCallId: call.id,
          name: call.name,
          state: 'running',
          input: parseArguments(call.arguments),
        });
      }
      syncTurnItem(items, current);
      continue;
    }

    if (message.role === 'tool') {
      const frame = currentTurnToolFrame(turn, message.toolCallId);
      if (frame && frame.kind === 'tool') {
        const output = textOf(message);
        const patched: TranscriptFrame = {
          ...frame,
          state: message.isError ? 'error' : 'done',
          output,
          error: message.isError ? output : undefined,
        };
        replaceToolFrame(turn!, message.toolCallId!, patched);
        syncTurnItem(items, turn!);
      }
    }
  }

  return { items, tasks: [], interactions: [], attachments, todos: [], prompts: [], meta: {} };
}

function classifyMediaUrl(
  url: string,
  family: 'image' | 'video',
): { mediaType: string; source?: TranscriptAttachment['source'] } | undefined {
  const fallback = `${family}/*`;
  const blobMime = /^blobref:([^;]+);[0-9a-f]{64}$/.exec(url)?.[1];
  if (blobMime !== undefined) return { mediaType: blobMime, source: { kind: 'blob', ref: url } };
  if (url.startsWith('data:')) {
    const mime = /^data:([^;,]+)/.exec(url)?.[1];
    return { mediaType: mime ?? fallback, source: { kind: 'url', url } };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { mediaType: fallback, source: { kind: 'url', url } };
  }
  return undefined;
}

function hubTurnOrigin(base: TurnOrigin, from: string): TurnOrigin {
  if (base.kind !== 'user') return base;
  const payload =
    typeof base.payload === 'object' && base.payload !== null
      ? { ...(base.payload as Record<string, unknown>), hubFrom: from }
      : { hubFrom: from };
  return { kind: 'user', payload };
}

function opensOwnTurn(message: HistoryMessage): boolean {
  const origin = message.origin as { kind?: unknown; name?: unknown } | undefined;
  return (
    typeof origin?.name === 'string' &&
    TURN_OPENING_SYSTEM_TRIGGERS.has(origin.name)
  );
}

function isUserSlashPrompt(message: HistoryMessage): boolean {
  const origin = message.origin as { kind?: unknown; trigger?: unknown } | undefined;
  return (
    (origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function mapOrigin(message: HistoryMessage): TurnOrigin {
  const origin = message.origin;
  switch (origin?.kind) {
    case 'cron_job':
    case 'cron_missed': {
      const jobId = (origin as { jobId?: unknown }).jobId;
      return { kind: 'cron', taskId: typeof jobId === 'string' ? jobId : undefined, payload: origin };
    }
    case 'task':
    case 'background_task': {
      const taskId = (origin as { taskId?: unknown }).taskId;
      return taskId !== undefined && typeof taskId === 'string'
        ? { kind: 'task', taskId, payload: origin }
        : { kind: 'other', payload: origin };
    }
    case 'hook_result':
      return { kind: 'hook', payload: origin };
    case 'shell_command':
      return { kind: 'user', payload: origin };
    case 'user':
    case undefined:
      return { kind: 'user' };
    default:
      return { kind: 'other', payload: origin };
  }
}

interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: string;
}

function bundledSkillActivations(message: HistoryMessage): readonly BundledSkillActivation[] {
  if (message.origin?.kind !== 'user') return [];
  const activations = (message.origin as { readonly skillActivations?: unknown }).skillActivations;
  if (!Array.isArray(activations)) return [];
  return activations.filter(
    (activation): activation is BundledSkillActivation =>
      typeof activation === 'object' &&
      activation !== null &&
      typeof (activation as { activationId?: unknown }).activationId === 'string' &&
      typeof (activation as { skillName?: unknown }).skillName === 'string',
  );
}

function textOf(message: HistoryMessage): string {
  return (message.content ?? [])
    .filter((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text' && 'text' in part)
    .map((part) => part.text)
    .join('');
}

function parseArguments(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function draftToTurnItem(draft: TurnDraft): TranscriptItem {
  return {
    kind: 'turn',
    turnId: draft.turnId,
    ordinal: draft.ordinal,
    state: 'completed',
    origin: draft.origin,
    prompt: draft.prompt,
    attachmentIds: draft.attachmentIds,
    steps: draft.steps.map((step) => ({
      kind: 'step' as const,
      stepId: step.stepId,
      turnId: draft.turnId,
      ordinal: step.ordinal,
      state: 'completed' as const,
      frames: step.frames,
    })),
  };
}

function syncTurnItem(items: TranscriptItem[], draft: TurnDraft): void {
  const index = items.findIndex((entry) => entry.kind === 'turn' && entry.turnId === draft.turnId);
  if (index >= 0) items[index] = draftToTurnItem(draft);
}

function currentTurnToolFrame(turn: TurnDraft | undefined, toolCallId: string | undefined): TranscriptFrame | undefined {
  if (!turn || toolCallId === undefined) return undefined;
  for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
    const frames = turn.steps[s]?.frames ?? [];
    for (let f = frames.length - 1; f >= 0; f -= 1) {
      const frame = frames[f];
      if (frame?.kind === 'tool' && frame.toolCallId === toolCallId) return frame;
    }
  }
  return undefined;
}

function replaceToolFrame(turn: TurnDraft, toolCallId: string, next: TranscriptFrame): void {
  for (let s = turn.steps.length - 1; s >= 0; s -= 1) {
    const step = turn.steps[s];
    if (!step) continue;
    const index = step.frames.findIndex((frame) => frame.kind === 'tool' && frame.toolCallId === toolCallId);
    if (index >= 0) {
      step.frames[index] = next;
      return;
    }
  }
}
