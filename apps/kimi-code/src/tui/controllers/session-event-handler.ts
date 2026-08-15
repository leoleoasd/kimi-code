import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type {
  AgentStatusUpdatedEvent,
  AssistantDeltaEvent,
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CronFiredEvent,
  ErrorEvent,
  Event,
  GoalChange,
  GoalUpdatedEvent,
  HookResultEvent,
  Session,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  PluginCommandActivatedEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
  TokenUsage,
  WarningEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { MoonLoader } from '../components/chrome/moon-loader';
import { buildGoalMarker } from '../components/messages/goal-markers';
import { StatusMessageComponent } from '../components/messages/status-message';
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from '../components/messages/swarm-markers';
import {
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
import {
  argsRecord,
  formatErrorPayload,
  formatErrorMessage,
  isTodoItemShape,
  serializeToolResultOutput,
  stringValue,
} from '../utils/event-payload';
import {
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  type UpcomingGoal,
} from '../goal-queue-store';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { formatHookResultMarkdown } from '../utils/hook-result-format';
import { McpOAuthAuthorizationUrlOpener } from '../utils/mcp-oauth';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { openUrl } from '#/utils/open-url';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { errorReportHintLine } from '../constant/feedback';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import { isPluginMcpToolName, PluginUpdateNotifier } from './plugin-update-notifier';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import { SubAgentEventHandler } from './subagent-event-handler';
import type {
  AppState,
  EngineQueuedPrompt,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';
import { createGoal as startGoalCommand } from '../commands/goal';

export interface SessionEventHost {
  state: TUIState;
  session: Session | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): Session;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  track(event: string, props?: Record<string, unknown>): void;
  recordSessionActivity(): void;
  noteStepUsage(usage: TokenUsage | undefined): void;
  noteCompactionFinished(): void;
  updateQueueDisplay(): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void;
  handleShellStarted(event: { commandId: string; taskId: string }): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  handleTurnStarted?(event: TurnStartedEvent): void;
  handleTurnEnded?(event: TurnEndedEvent): void;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}

// ---------------------------------------------------------------------------
// Engine-side prompt queue (`appState.engineQueuedPrompts`)
// ---------------------------------------------------------------------------
//
// The queue strip below the editor shows this TUI's OWN client-side queue
// (`state.queuedMessages`). Other surfaces — a hub web UI / remote-control
// client driving the same session over kap-server — submit straight into the
// ENGINE's per-agent FIFO, which only surfaces here through events:
//
// - `prompt.queued` — the v2 engine fact (agent-core-v2 `publishQueued`); not
//   part of the v1 `Event` union, so `handleEvent` matches it before the typed
//   switch. The engine publishes it only for user-origin prompts: plugin
//   commands, skill activations, subagent turns use non-user origins, and cron
//   / goal continuations / task notifications bypass the prompt queue.
// - `prompt.submitted` — the v1 wire shape. `status` 'queued' mirrors
//   `prompt.queued`; 'running' is the REMOVE signal: the launching of a queued
//   prompt (v1 republishes the same promptId on launch). The v2 engine has no
//   dedicated queued→launch event, so on v2 an entry lingers until its own
//   terminal event — the strip errs on the side of showing a message that is
//   about to run.
// - `prompt.completed` / `prompt.aborted` settle a prompt (remove);
//   `prompt.steered` absorbs pending prompts into the active turn (remove).
//
// Own-surface echoes exist and are displayed on purpose: ctrl-s steer and a
// local-queue drain racing another launch both land in the engine FIFO, so
// the strip simply echoes engine reality (steers are removed by the follow-up
// `prompt.steered`).

/** Runtime shape of the v2-only `prompt.queued` domain event
 * (`packages/agent-core-v2/src/agent/prompt/promptService.ts`); not in the v1
 * `Event` union, so it is matched structurally before the typed switch. */
interface EnginePromptQueuedEvent {
  readonly promptId: string;
  readonly content: readonly unknown[];
}

/** Runtime shape of the v2-only `turn.started.content` field
 * (`packages/agent-core-v2/src/agent/loop/turnEvents.ts`): the turn's full
 * input parts (media included), published for displayable origins when the
 * input has non-text parts. The v1 `TurnStartedEvent` in
 * `packages/protocol` has no such field, so it is read structurally, the
 * same way `prompt.queued` above is matched. */
interface TurnStartedContentEvent {
  readonly content?: readonly unknown[];
}

const ENGINE_QUEUE_TEXT_CAP = 40;
const ENGINE_QUEUE_MEDIA_PLACEHOLDER = '🖼';

/**
 * `[image #1] [video #2]`-style markers for media parts the engine strips
 * from the turn's prompt text (mirrors the composer's paste-time
 * placeholders; replay's own translation `mediaUrlPartToText` is richer —
 * this deliberately only marks presence/type, no fetch).
 */
export function mediaPlaceholderSuffix(content: readonly unknown[] | undefined): string {
  if (content === undefined) return '';
  const markers: string[] = [];
  let images = 0;
  let videos = 0;
  for (const part of content) {
    if (typeof part !== 'object' || part === null || !('type' in part)) continue;
    if ((part as { type?: unknown }).type === 'image_url') {
      images += 1;
      markers.push(`[image #${String(images)}]`);
    } else if ((part as { type?: unknown }).type === 'video_url') {
      videos += 1;
      markers.push(`[video #${String(videos)}]`);
    }
  }
  return markers.length === 0 ? '' : ` ${markers.join(' ')}`;
}

/** Compact a queued prompt's content parts into one display line (whitespace
 * collapsed, ~40ch cap, 🖼 fallback for media-only prompts). */
export function extractEngineQueuedText(content: readonly unknown[]): string {
  const text = content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const display = text.length === 0 ? ENGINE_QUEUE_MEDIA_PLACEHOLDER : text;
  return display.length > ENGINE_QUEUE_TEXT_CAP ? `${display.slice(0, ENGINE_QUEUE_TEXT_CAP)}…` : display;
}

/** Append or replace (same position) the entry keyed by `promptId`. Returns
 * the input unchanged when the stored text already matches, so callers can
 * skip the repaint on repeat events. */
export function upsertEngineQueuedPrompt(
  list: readonly EngineQueuedPrompt[],
  entry: EngineQueuedPrompt,
): EngineQueuedPrompt[] {
  const index = list.findIndex((item) => item.promptId === entry.promptId);
  if (index === -1) return [...list, entry];
  if (list[index]!.text === entry.text) return list as EngineQueuedPrompt[];
  const next = list.slice();
  next[index] = entry;
  return next;
}

/** Drop every entry whose `promptId` is in `promptIds`. Returns the input
 * unchanged when nothing matched. */
export function removeEngineQueuedPrompts(
  list: readonly EngineQueuedPrompt[],
  promptIds: readonly string[],
): EngineQueuedPrompt[] {
  const drop = new Set(promptIds);
  const next = list.filter((item) => !drop.has(item.promptId));
  return next.length === list.length ? (list as EngineQueuedPrompt[]) : next;
}

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;
  private readonly pluginUpdateNotifier: PluginUpdateNotifier;

  constructor(
    private readonly host: SessionEventHost,
    pluginUpdateNotifier?: PluginUpdateNotifier,
  ) {
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal: this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
    });
    this.pluginUpdateNotifier =
      pluginUpdateNotifier ??
      new PluginUpdateNotifier({
        getSession: () => this.host.session,
        workDir: host.state.appState.workDir,
        notify: (message) => {
          this.host.showStatus(message, 'warning');
        },
      });
  }

  // Runtime state – owned by this handler, reset between sessions.
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedPluginCommandActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  /**
   * FIFO of prompts this TUI just echoed locally (both queued and direct
   * submissions), capped small. A `turn.started` carrying the same prompt
   * text consumes one record and skips its user bubble — turns submitted
   * from ANOTHER surface (a hub / remote-control UI driving this same
   * session) render their user message from the event. A missed match only
   * collapses two indistinguishable texts; it can never duplicate a bubble.
   */
  private recentLocalPromptTexts: string[] = [];
  /**
   * promptId → the queued prompt's content parts (engine `prompt.queued`).
   * Fifo-consulted at `turn.started` (user origin) for media markers — the
   * engine strips media from its `turn.started.prompt` payload, and the
   * remote-echo bubble needs SOMETHING visual where a local paste would show
   * its thumbnail. Purged on abort / steer / completion and on consumption.
   */
  private readonly pendingQueuedContents = new Map<string, readonly unknown[]>();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  private goalCompletionAwaitingClear = false;
  private goalCompletionTurnEnded = false;
  private currentTurnHasAssistantText = false;
  private pluginCommandTurns: Map<string, string> = new Map();
  private pluginMcpToolsUsedInTurn: Set<string> = new Set();
  private pendingModelBlockedFallback: GoalChange | undefined;
  private queuedGoalPromotionPending = false;
  private queuedGoalPromotionInFlight = false;
  private queuedGoalPromotionTimer: ReturnType<typeof setTimeout> | undefined;
  private stepRetryAttemptTimer: ReturnType<typeof setTimeout> | undefined;

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedPluginCommandActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.recentLocalPromptTexts = [];
    this.pendingQueuedContents.clear();
    this.mcpServers.clear();
    this.goalCompletionAwaitingClear = false;
    this.goalCompletionTurnEnded = false;
    this.currentTurnHasAssistantText = false;
    this.pluginCommandTurns.clear();
    this.pluginMcpToolsUsedInTurn.clear();
    this.pendingModelBlockedFallback = undefined;
    this.queuedGoalPromotionPending = false;
    this.queuedGoalPromotionInFlight = false;
    this.clearQueuedGoalPromotionTimer();
    this.clearStepRetryAttemptTimer();
    this.stopAllMcpServerStatusSpinners();
  }

  clearAgentSwarmProgress(): void {
    this.subAgentEventHandler.clearAgentSwarmProgress();
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return this.subAgentEventHandler.hasActiveAgentSwarmToolCall();
  }

  syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.subAgentEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = host.state.appState;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === 'tool.progress') {
        mcpOAuthOpener.handleToolProgress(event);
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(`Failed to sync MCP server status: ${message}`);
      return;
    }
    if (host.session !== session || host.state.appState.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    this.mcpServers.clear();
    for (const server of servers) {
      this.mcpServers.set(server.name, server);
    }
    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
      hidden.push(server);
    }
    const summary = formatMcpStartupStatusSummary(servers);
    host.setAppState({ mcpServersSummary: summary || null });
  }

  handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.subAgentEventHandler.routeChildAgentEvent(event)) return;

    // `prompt.queued` is a v2-only fact outside the v1 `Event` union — a typed
    // `case` below would not typecheck, so match it structurally up front.
    if ((event as { type: string }).type === 'prompt.queued') {
      const queued = event as unknown as EnginePromptQueuedEvent;
      // Remember content per queued prompt so the turn-begin echo can mark
      // media the engine itself strips from `turn.started.prompt` (images,
      // videos) — the engine only publishes queued events for user-origin
      // prompts and dequeues them FIFO (v2 engine: `publishQueued`).
      this.pendingQueuedContents.set(queued.promptId, queued.content);
      this.applyEngineQueuePatch(
        upsertEngineQueuedPrompt(this.host.state.appState.engineQueuedPrompts, {
          promptId: queued.promptId,
          text: extractEngineQueuedText(queued.content),
        }),
      );
      return;
    }

    if ('turnId' in event && event.turnId !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turnId));
    }

    switch (event.type) {
      case 'turn.started': this.handleTurnBegin(event); break;
      case 'turn.ended': this.handleTurnEnd(event, sendQueued); break;
      case 'turn.step.started': this.handleStepBegin(event); break;
      case 'turn.step.interrupted': this.handleStepInterrupted(event); break;
      case 'turn.step.completed': this.handleStepCompleted(event); break;
      case 'turn.step.retrying': this.handleStepRetrying(event); break;
      case 'tool.progress': this.handleToolProgress(event); break;
      case 'shell.output': this.host.handleShellOutput(event); break;
      case 'shell.started': this.host.handleShellStarted(event); break;
      case 'assistant.delta': this.handleAssistantDelta(event); break;
      case 'hook.result': this.handleHookResult(event); break;
      case 'thinking.delta': this.handleThinkingDelta(event); break;
      case 'tool.call.started': this.handleToolCall(event); break;
      case 'tool.call.delta': this.handleToolCallDelta(event); break;
      case 'tool.result': this.handleToolResult(event); break;
      case 'agent.status.updated': this.handleStatusUpdate(event); break;
      case 'session.meta.updated': this.handleSessionMetaChanged(event); break;
      case 'goal.updated': this.handleGoalUpdated(event); break;
      case 'skill.activated': this.handleSkillActivated(event); break;
      case 'plugin_command.activated': this.handlePluginCommandActivated(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'compaction.started': this.handleCompactionBegin(event); break;
      case 'compaction.completed': this.handleCompactionEnd(event, sendQueued); break;
      case 'compaction.blocked': break;
      case 'compaction.cancelled': this.handleCompactionCancel(event, sendQueued); break;
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.suspended':
      case 'subagent.completed':
      case 'subagent.failed':
        this.subAgentEventHandler.handleLifecycleEvent(event); break;
      case 'background.task.started':
      case 'background.task.terminated':
        this.handleBackgroundTaskEvent(event); break;
      case 'cron.fired': this.handleCronFired(event); break;
      case 'mcp.server.status': this.renderMcpServerStatus(event.server); break;
      case 'prompt.submitted': this.handlePromptSubmitted(event); break;
      case 'prompt.completed':
      case 'prompt.aborted': this.dropEngineQueuedPrompts([event.promptId]); break;
      case 'prompt.steered': this.dropEngineQueuedPrompts(event.promptIds); break;
      case 'tool.list.updated': break;
      default: break;
    }
  }

  stopAllMcpServerStatusSpinners(): void {
    for (const spinner of this.mcpServerStatusSpinners.values()) {
      spinner.stop();
    }
    this.mcpServerStatusSpinners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  /**
   * Record a prompt this TUI just echoed locally, BEFORE sending it. See the
   * field doc on {@link recentLocalPromptTexts} for the dedup contract.
   */
  recordLocalPromptText(text: string): void {
    this.recentLocalPromptTexts.push(text);
    if (this.recentLocalPromptTexts.length > 16) this.recentLocalPromptTexts.shift();
  }

  private consumeLocalPromptText(text: string): boolean {
    const index = this.recentLocalPromptTexts.indexOf(text);
    if (index === -1) return false;
    this.recentLocalPromptTexts.splice(index, 1);
    return true;
  }

  /**
   * `prompt.submitted`: 'queued' mirrors `prompt.queued` (upsert); the other
   * statuses mean the queued prompt left the FIFO — the v1 daemon republishes
   * the same promptId with 'running' on launch — so drop it from the strip.
   */
  private handlePromptSubmitted(event: Extract<Event, { type: 'prompt.submitted' }>): void {
    if (event.status === 'queued') {
      this.applyEngineQueuePatch(
        upsertEngineQueuedPrompt(this.host.state.appState.engineQueuedPrompts, {
          promptId: event.promptId,
          text: extractEngineQueuedText(event.content),
        }),
      );
      return;
    }
    this.dropEngineQueuedPrompts([event.promptId]);
  }

  private dropEngineQueuedPrompts(promptIds: readonly string[]): void {
    for (const promptId of promptIds) this.pendingQueuedContents.delete(promptId);
    this.applyEngineQueuePatch(
      removeEngineQueuedPrompts(this.host.state.appState.engineQueuedPrompts, promptIds),
    );
  }

  /** FIFO shift of the oldest remembered queued content (engine dequeues in order); `undefined` when none is remembered. */
  private shiftOldestQueuedContent(): readonly unknown[] | undefined {
    const first = this.pendingQueuedContents.keys().next();
    if (first.done === true) return undefined;
    const content = this.pendingQueuedContents.get(first.value);
    this.pendingQueuedContents.delete(first.value);
    return content;
  }

  private applyEngineQueuePatch(next: EngineQueuedPrompt[]): void {
    if (next === this.host.state.appState.engineQueuedPrompts) return;
    this.host.setAppState({ engineQueuedPrompts: next });
    this.host.updateQueueDisplay();
    this.host.state.ui.requestRender();
  }

  private handleTurnBegin(event: TurnStartedEvent): void {
    this.host.handleTurnStarted?.(event);
    this.currentTurnHasAssistantText = false;
    if (event.origin?.kind === 'plugin_command') {
      this.pluginCommandTurns.set(String(event.turnId), event.origin.pluginId);
    }
    // Own prompts are shown by the local echo at submit time; a user-origin
    // turn whose prompt did NOT come from this TUI (a hub / remote-control UI
    // driving the same live session) renders its user message from here.
    if (event.origin?.kind === 'user' && event.prompt !== undefined) {
      // FIFO-consume the matching queued content for EVERY user-origin turn
      // (the engine dequeues in order) — even when the event itself carries
      // the turn's parts, so the strip stays aligned for the NEXT turn whose
      // event lacks them. The v2 engine's `turn.started.content` (full input
      // parts for displayable origins with media) wins when present; the
      // `prompt.queued` record is the fallback. The markers ride the remote
      // echo; the locally-sent path dedups against `recentLocalPromptTexts`
      // and keeps its own (already thumbnail-rendered) local entry.
      const queuedContent = this.shiftOldestQueuedContent();
      const content = (event as unknown as TurnStartedContentEvent).content ?? queuedContent;
      if (!this.consumeLocalPromptText(event.prompt)) {
        this.host.appendTranscriptEntry({
          id: nextTranscriptId(),
          kind: 'user',
          turnId: undefined,
          renderMode: 'plain',
          content: event.prompt + mediaPlaceholderSuffix(content),
        });
      }
    }
    this.clearAgentSwarmProgress();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private handleCronFired(event: CronFiredEvent): void {
    this.host.streamingUI.flushNow();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'cron',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: event.prompt,
      cronData: {
        jobId: event.origin.jobId,
        cron: event.origin.cron,
        recurring: event.origin.recurring,
        coalescedCount: event.origin.coalescedCount,
        stale: event.origin.stale,
      },
    });
  }

  private handleTurnEnd(event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    this.host.handleTurnEnded?.(event);
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    if (event.reason === 'cancelled') {
      this.markActiveAgentSwarmsCancelled();
    }
    // Aborted foreground subagents emit no completed/failed lifecycle event
    // (v2 suppresses it for aborts), so their activity records would linger
    // until the session reset — prune them when the owning turn ends.
    this.subAgentEventHandler.dropForegroundOnlyActivityRecords();
    if (event.reason === 'failed' && event.error?.code === 'provider.filtered') {
      this.host.showStatus('Turn stopped: provider safety policy blocked the response.', 'error');
    }
    if (event.reason === 'blocked') {
      this.host.showStatus('Turn stopped: prompt hook blocked the request.', 'error');
    }
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.host.recordSessionActivity();
    this.renderPendingModelBlockedFallback();
    this.currentTurnHasAssistantText = false;
    this.goalCompletionTurnEnded = true;
    // Plugin usage is reported once the whole turn's output has ended — but a
    // cancelled turn cut the output short, so skip the notice there.
    const reportPluginUsage = event.reason !== 'cancelled';
    const pluginCommandPluginId = this.pluginCommandTurns.get(String(event.turnId));
    if (pluginCommandPluginId !== undefined) {
      this.pluginCommandTurns.delete(String(event.turnId));
      if (reportPluginUsage) {
        void this.pluginUpdateNotifier.handlePluginCommandCompleted(pluginCommandPluginId);
      }
    }
    if (reportPluginUsage) {
      for (const toolName of this.pluginMcpToolsUsedInTurn) {
        void this.pluginUpdateNotifier.handleMcpToolCompleted(toolName);
      }
    }
    this.pluginMcpToolsUsedInTurn.clear();
    this.scheduleQueuedGoalPromotion();
  }

  private handleStepBegin(event: TurnStepStartedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    this.host.noteStepUsage(event.usage);
    this.maybeShowDebugTiming(event);

    if (event.providerFinishReason === 'filtered') {
      this.host.showNotice(
        'Provider safety policy blocked the response.',
        `The model output was filtered (${event.rawFinishReason ?? 'content_filter'}).`,
      );
      return;
    }

    if (event.finishReason !== 'max_tokens') return;

    const truncatedCount = this.host.streamingUI.markStepTruncated(
      String(event.turnId),
      event.step,
    );

    const title =
      truncatedCount > 0
        ? 'Model hit max_tokens — tool call was truncated before it could run.'
        : 'Model hit max_tokens — no tool call was emitted.';
    const detail = this.isAnthropicSessionActive()
      ? 'If this limit is wrong for your model, set `max_output_size` on the model alias in your kimi-code config.'
      : undefined;
    this.host.showNotice(title, detail);
  }

  private handleStepRetrying(event: TurnStepRetryingEvent): void {
    // The failure may arrive mid-stream, after thinking/assistant deltas have
    // parked the pane in `thinking`/`composing` — drive it back to waiting so
    // the retry label and detail actually render during the backoff.
    this.host.patchLivePane({ mode: 'waiting' });
    this.host.setAppState({
      streamingPhase: 'waiting',
      stepRetry: {
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
        phase: 'backoff',
      },
    });
    // Both engines sleep for `delayMs` before the next attempt runs, but only
    // v2 re-emits `turn.step.started` for it — flip the phase on a timer so the
    // stale countdown drops on the legacy engine too.
    this.clearStepRetryAttemptTimer();
    this.stepRetryAttemptTimer = setTimeout(() => {
      this.stepRetryAttemptTimer = undefined;
      const retry = this.host.state.appState.stepRetry;
      if (retry === null) return;
      this.host.setAppState({ stepRetry: { ...retry, phase: 'attempt' } });
    }, event.delayMs);
  }

  private clearStepRetry(): void {
    this.clearStepRetryAttemptTimer();
    if (this.host.state.appState.stepRetry === null) return;
    this.host.setAppState({ stepRetry: null });
  }

  clearStepRetryAttemptTimer(): void {
    if (this.stepRetryAttemptTimer !== undefined) {
      clearTimeout(this.stepRetryAttemptTimer);
      this.stepRetryAttemptTimer = undefined;
    }
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env['KIMI_CODE_DEBUG'] !== '1') return;
    const text = formatStepDebugTiming(event);
    if (text === undefined) return;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: String(event.turnId),
      renderMode: 'plain',
      content: text,
    });
  }

  private markActiveAgentSwarmsCancelled(): void {
    this.subAgentEventHandler.markActiveAgentSwarmsCancelled();
  }

  private isAnthropicSessionActive(): boolean {
    const { state } = this.host;
    const model = state.appState.availableModels[state.appState.model];
    if (model === undefined) return false;
    if (model.protocol === 'anthropic') return true;
    return state.appState.availableProviders[model.provider]?.type === 'anthropic';
  }

  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.markActiveAgentSwarmsCancelled();
      if (event.message === undefined || event.message === '') {
        this.host.showStatus('Interrupted by user', 'error');
      } else {
        this.host.showError(event.message);
      }
      return;
    }
    this.host.showError(
      reason === 'max_steps'
        ? 'reached per-turn step limit (max_steps)'
        : `step interrupted (${reason})`,
    );
  }

  private handleThinkingDelta(event: ThinkingDeltaEvent): void {
    const { state, streamingUI } = this.host;
    // Encrypted / redacted reasoning (e.g. Kimi over the Anthropic-compatible
    // protocol) streams thinking deltas whose visible text is empty — only an
    // opaque signature rides along. Models also occasionally stream whitespace-
    // only thinking (e.g. a single space). Such deltas carry nothing to render,
    // so switching into the `thinking` pane mode here would stop the "waiting"
    // moon spinner while no ThinkingComponent is ever created (it needs visible
    // text), leaving a blank, spinner-less gap until the first real text/tool
    // token arrives. Keep the moon up until actual thinking text shows up.
    if (event.delta.trim().length === 0 && !streamingUI.hasThinkingDraft()) return;
    streamingUI.appendThinkingDelta(event.delta);
    this.host.patchLivePane({ mode: 'idle' });
    if (state.appState.streamingPhase !== 'thinking') {
      this.host.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: AssistantDeltaEvent): void {
    const { state, streamingUI } = this.host;
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript('idle');
    }

    if (event.delta.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    streamingUI.appendAssistantDelta(event.delta);

    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleHookResult(event: HookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript('idle');
    }
    this.host.streamingUI.finalizeAssistantStream();
    if (event.content.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(event.turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
      hookResult: true,
    });
    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCall(event: ToolCallStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    if (event.name === 'AgentSwarm') {
      this.subAgentEventHandler.handleAgentSwarmToolCallStarted(event.toolCallId, toolCall.args);
    }
    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCallDelta(event: ToolCallDeltaEvent): void {
    if (event.toolCallId.length === 0) return;
    const { state, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
    const preview = streamingUI.getStreamingToolCallPreview(event.toolCallId);
    if (
      preview !== undefined &&
      (preview.name === 'AgentSwarm' || this.subAgentEventHandler.hasAgentSwarmProgress(event.toolCallId))
    ) {
      this.subAgentEventHandler.handleAgentSwarmToolCallDelta(event.toolCallId, preview.args, {
        streamingArguments: preview.argumentsText,
      });
    }

    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleToolProgress(event: ToolProgressEvent): void {
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    if (event.update.kind === 'status') {
      tc.appendProgress(text, { replace: event.update.replace === true });
      return;
    }
    if (event.update.kind === 'stdout' || event.update.kind === 'stderr') {
      tc.appendLiveOutput(text);
    }
  }

  private handleToolResult(event: ToolResultEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    this.clearStepRetry();
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
    };
    const matchedCall = streamingUI.completeToolResult(event.toolCallId, resultData);
    if (matchedCall !== undefined && isPluginMcpToolName(matchedCall.name)) {
      // Buffer plugin MCP usage for the turn; the update notice fires once the
      // whole turn's output has ended (see handleTurnEnd).
      this.pluginMcpToolsUsedInTurn.add(matchedCall.name);
    }
    this.subAgentEventHandler.handleAgentSwarmToolResult(
      event.toolCallId,
      resultData,
      event.isError === true,
    );
    if (matchedCall !== undefined && matchedCall.name === 'TodoList' && !event.isError) {
      const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
      if (Array.isArray(rawTodos)) {
        const sanitized = rawTodos
          .filter((todo): todo is { title: string; status: 'pending' | 'in_progress' | 'done' } =>
            isTodoItemShape(todo),
          )
          .map((t) => ({ title: t.title, status: t.status }));
        streamingUI.setTodoList(sanitized);
      }
    }
    this.host.patchLivePane({ mode: 'waiting' });
  }

  private handleStatusUpdate(event: AgentStatusUpdatedEvent): void {
    const shouldRenderSwarmEnded =
      event.swarmMode === false &&
      this.host.state.appState.swarmMode &&
      this.host.state.swarmModeEntry === 'task';
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined) patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.swarmMode !== undefined) patch.swarmMode = event.swarmMode;
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
    }
    if (event.model !== undefined) patch.model = event.model;
    if (event.thinkingEffort !== undefined) patch.thinkingEffort = event.thinkingEffort;
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
    if (event.swarmMode === false) {
      this.host.state.swarmModeEntry = undefined;
      if (shouldRenderSwarmEnded) {
        this.renderSwarmModeMarker('ended');
      }
    }
  }

  private renderSwarmModeMarker(state: SwarmModeMarkerState): void {
    this.host.state.transcriptContainer.addChild(
      new SwarmModeMarkerComponent(state),
    );
    this.host.state.ui.requestRender();
  }

  private handleGoalUpdated(event: GoalUpdatedEvent): void {
    this.host.setAppState({ goal: event.snapshot });
    if (event.snapshot === null && this.goalCompletionAwaitingClear) {
      this.goalCompletionAwaitingClear = false;
      this.queuedGoalPromotionPending = true;
      this.scheduleQueuedGoalPromotion();
    }
    if (event.snapshot === null) {
      this.pendingModelBlockedFallback = undefined;
    }
    const change = event.change;
    if (change === undefined) return;
    const { state } = this.host;

    // Completion -> the box disappears (snapshot cleared on the follow-up null
    // update) and a deterministic completion message lands in the transcript.
    // Resume renders the same text from the durable goal completion replay
    // record, so live and replayed completion cards stay identical.
    if (change.kind === 'completion' && event.snapshot !== null) {
      this.pendingModelBlockedFallback = undefined;
      this.goalCompletionAwaitingClear = true;
      this.goalCompletionTurnEnded = false;
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'assistant',
        renderMode: 'markdown',
        content: buildGoalCompletionMessage(event.snapshot),
      });
      state.ui.requestRender();
      return;
    }

    // Lifecycle change (pause / resume / blocked) -> a low-profile,
    // ctrl+o-expandable marker.
    if (change.kind === 'lifecycle' && change.status === 'blocked') {
      void this.notifyQueuedGoalWaitingOnBlocked();
      if (change.actor === 'model' || change.reason === undefined) {
        this.pendingModelBlockedFallback = this.currentTurnHasAssistantText
          ? undefined
          : change;
        return;
      }
      this.pendingModelBlockedFallback = undefined;
    } else if (change.kind === 'lifecycle') {
      this.pendingModelBlockedFallback = undefined;
    }
    const marker = buildGoalMarker(change, state.toolOutputExpanded, change.actor);
    if (marker !== null) {
      state.transcriptContainer.addChild(marker);
      state.ui.requestRender();
    }
  }

  private renderPendingModelBlockedFallback(): void {
    const change = this.pendingModelBlockedFallback;
    if (change === undefined) return;
    this.pendingModelBlockedFallback = undefined;
    const { state } = this.host;
    const marker = buildGoalMarker(change, state.toolOutputExpanded, 'model');
    if (marker !== null) {
      state.transcriptContainer.addChild(marker);
      state.ui.requestRender();
    }
  }

  private scheduleQueuedGoalPromotion(): void {
    if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
    if (this.queuedGoalPromotionInFlight) return;
    if (this.queuedGoalPromotionTimer !== undefined) return;
    this.queuedGoalPromotionTimer = setTimeout(() => {
      this.queuedGoalPromotionTimer = undefined;
      if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
      if (this.queuedGoalPromotionInFlight) return;
      if (!this.isReadyForQueuedGoalPromotion()) {
        return;
      }
      this.queuedGoalPromotionInFlight = true;
      void this.promoteNextQueuedGoal()
        .then((complete) => {
          if (complete) {
            this.queuedGoalPromotionPending = false;
            this.goalCompletionTurnEnded = false;
            return;
          }
          this.goalCompletionTurnEnded = false;
        })
        .finally(() => {
          this.queuedGoalPromotionInFlight = false;
          this.scheduleQueuedGoalPromotion();
        });
    }, 0);
  }

  private clearQueuedGoalPromotionTimer(): void {
    if (this.queuedGoalPromotionTimer === undefined) return;
    clearTimeout(this.queuedGoalPromotionTimer);
    this.queuedGoalPromotionTimer = undefined;
  }

  requestQueuedGoalPromotion(): void {
    this.queuedGoalPromotionPending = true;
    this.goalCompletionTurnEnded = true;
    this.scheduleQueuedGoalPromotion();
  }

  retryQueuedGoalPromotion(): void {
    this.scheduleQueuedGoalPromotion();
  }

  private isReadyForQueuedGoalPromotion(session?: Session): boolean {
    return (
      (session === undefined || this.host.session === session) &&
      !this.host.aborted &&
      this.host.state.appState.streamingPhase === 'idle' &&
      this.host.state.queuedMessages.length === 0 &&
      !this.host.state.queuedMessageDispatchPending
    );
  }

  private async promoteNextQueuedGoal(): Promise<boolean> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return true;

    let queue;
    try {
      queue = await readGoalQueue(session);
    } catch (error) {
      host.showError(`Failed to read upcoming goals: ${formatErrorMessage(error)}`);
      return false;
    }
    if (host.session !== session || host.aborted) return true;

    const next = queue.goals[0];
    if (next === undefined) return true;

    if (!this.isReadyForQueuedGoalPromotion(session)) return false;

    const started = await startGoalCommand(
      host,
      { kind: 'create', objective: next.objective, replace: false },
      next.objective,
      {
        beforeSend: async () => {
          if (!this.isReadyForQueuedGoalPromotion(session)) {
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          try {
            await removeGoalQueueItem(session, { goalId: next.id });
          } catch (error) {
            host.showError(
              `Queued goal started, but could not be removed from the queue: ${formatErrorMessage(error)}`,
            );
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          if (this.isReadyForQueuedGoalPromotion(session)) {
            return true;
          }
          await this.restoreAndCancelStartedQueuedGoal(session, next);
          return false;
        },
        sendInput: (objective) => {
          host.sendQueuedMessage(session, { text: objective });
        },
      },
    );
    return started || host.session !== session || host.aborted;
  }

  private async restoreAndCancelStartedQueuedGoal(
    session: Session,
    goal: UpcomingGoal,
  ): Promise<void> {
    try {
      await restoreGoalQueueItem(session, goal);
    } catch (error) {
      this.host.showError(`Queued goal could not be restored: ${formatErrorMessage(error)}`);
    }
    await this.cancelStartedQueuedGoal(session);
  }

  private async cancelStartedQueuedGoal(session: Session): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (error) {
      this.host.showError(`Queued goal could not be cancelled: ${formatErrorMessage(error)}`);
    }
  }

  private async notifyQueuedGoalWaitingOnBlocked(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return;

    let hasQueuedGoal = false;
    try {
      const queue = await readGoalQueue(session);
      hasQueuedGoal = queue.goals.length > 0;
    } catch {
      return;
    }
    if (!hasQueuedGoal || host.session !== session || host.aborted) return;

    host.showNotice(
      'Goal blocked.',
      'The next queued goal will start only after this goal is complete.',
    );
  }

  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.['title']);
    if (title !== undefined) {
      this.host.setAppState({ sessionTitle: title });
      this.host.updateTerminalTitle();
    }
  }

  private handleSessionError(event: ErrorEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    if (event.code === OAUTH_LOGIN_REQUIRED_CODE) {
      this.host.showError(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
      return;
    }
    this.host.showError(formatErrorPayload(event));
    const sessionId = this.host.state.appState.sessionId;
    if (sessionId.length > 0) {
      this.host.showStatus(errorReportHintLine());
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(`Warning: ${event.message}`, 'warning');
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case 'connected': {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, 'success');
        return;
      }
      case 'failed': {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeMcpServerStatusRow(server.name, message, 'error');
        return;
      }
      case 'needs-auth': {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeMcpServerStatusRow(server.name, message, 'warning');
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" disabled`,
          'textMuted',
        );
        return;
      case 'removed':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" removed`,
          'textMuted',
        );
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP server "${name}" connecting…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => currentTheme.fg('textMuted', s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: ColorToken): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      // In-place replacement is picked up by the container's ref-checked
      // render cache; a tree-wide invalidate is unnecessary (and costly).
      children[idx] = status;
    } else {
      state.transcriptContainer.addChild(status);
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `Activated skill: ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      skillTrigger: event.trigger,
    });
  }

  private handlePluginCommandActivated(event: PluginCommandActivatedEvent): void {
    if (this.renderedPluginCommandActivationIds.has(event.activationId)) return;
    this.renderedPluginCommandActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'plugin_command',
      turnId: undefined,
      renderMode: 'plain',
      content: `/${event.pluginId}:${event.commandName}`,
      pluginCommandData: {
        activationId: event.activationId,
        pluginId: event.pluginId,
        commandName: event.commandName,
        args: event.commandArgs,
        trigger: event.trigger,
      },
    });
  }

  private handleCompactionBegin(event: CompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  private handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.endCompaction(
      event.result.tokensBefore,
      event.result.tokensAfter,
      event.result.summary,
    );
    // A completed compaction just refreshed and shrank the cached context —
    // count it as activity so the next submit isn't judged against the
    // pre-compaction timestamp, and reset the cache-break baseline (the drop
    // is expected). Cancellations do neither: the context was not cut.
    this.host.recordSessionActivity();
    this.host.noteCompactionFinished();
    this.finishCompaction(sendQueued);
  }

  private handleCompactionCancel(
    _event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.cancelCompaction();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        this.host.state.queuedMessageDispatchPending = true;
      }
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          this.host.state.queuedMessageDispatchPending = false;
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

  private handleBackgroundTaskEvent(
    event: BackgroundTaskStartedEvent | BackgroundTaskTerminatedEvent,
  ): void {
    const { state } = this.host;
    const { info } = event;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });
    }

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'timed_out' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'background.task.started') {
      if (info.kind === 'agent') {
        // A foreground subagent detached via Ctrl+B: flip its card to
        // `◐ backgrounded` so it doesn't look like it completed.
        this.host.streamingUI.markSubagentBackgrounded(info.agentId);
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'background.task.terminated' && isTerminal) {
      if (info.kind === 'agent') {
        // The Agent tool's spawn-success ToolResult is not an error, so the
        // parent toolCall card would otherwise render `✓ Completed` for any
        // terminated bg agent — including `lost` / `failed` / `killed`.
        // Push the actual terminal status so the card matches reality.
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
        // Stopped / timed-out agents terminate without a `subagent.failed`
        // event — mark the activity record here so the detail view does not
        // stay "running" forever. `subagent.completed` carries the result
        // summary and may land after this, so only fill still-running records.
        const agentId = info.agentId;
        if (agentId !== undefined) {
          const record = this.subAgentEventHandler.activityStore.get(agentId);
          if (record !== undefined && record.status === 'running') {
            if (info.status === 'completed') {
              this.subAgentEventHandler.activityStore.markCompleted(agentId);
            } else {
              this.subAgentEventHandler.activityStore.markFailed(agentId);
            }
          }
        }
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.kind === 'process' || info.kind === 'question') {
          this.appendBackgroundTaskEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundTaskBadge(): void {
    const { state } = this.host;
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.backgroundTasks.values()) {
      if (
        info.status === 'completed' ||
        info.status === 'failed' ||
        info.status === 'timed_out' ||
        info.status === 'killed' ||
        info.status === 'lost'
      ) {
        continue;
      }
      if (info.kind === 'agent') {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    state.footer.setBackgroundCounts({ bashTasks, agentTasks });
    state.ui.requestRender();
  }
}
