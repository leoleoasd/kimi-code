/**
 * Prompt composer — the ONE input surface: auto-growing textarea, IME-safe
 * Enter-to-send, image attachments (paste + drag-and-drop → `/api/v1/files`),
 * and the slash-command intercept.
 *
 *  - Enter sends, Shift+Enter newline; NEVER mid-IME-composition
 *    (`nativeEvent.isComposing`) — that's candidate selection, not a send
 *    gesture. `isComposing` is the single source of truth: a companion
 *    compositionstart/end tracker once co-guarded this, but a missed
 *    compositionend on mobile IMEs leaves the tracker stuck true and
 *    swallows EVERY later Enter forever.
 *  - Paste/drop: image items become attachment chips; `preventDefault` only
 *    fires when at least one image was actually present, so pasting plain
 *    text still lands in the textarea. A failed upload keeps the chip (red ✕,
 *    retry = re-upload once, or remove); SEND waits for every chip to be
 *    READY ("Uploading…" button state). Text and chips clear TOGETHER on send
 *    (a hung REST round-trip must not leave the composer half-closed); on a
 *    send ERROR the text comes back for retry while chips stay dropped
 *    server-side anyway (object URLs revoked).
 *  - Slash commands are intercepted BEFORE sending: every `/…` line forwards
 *    verbatim to the agent's command bridge (the connected TUI's dispatch —
 *    sessions/commands.ts keeps NO second grammar); only `/copy` and
 *    `/export-debug-zip` run browser-locally.
 *
 * The decision logic lives in the exported pure helpers (`planSendOnEnter`,
 * `planComposerKey`, `planComposerAction`, `collectImagesFromClipboard`) so
 * tests stay headless — this package has no component-test harness.
 */

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import { parseComposerCommand, type ComposerAction } from '#/sessions/commands';
import type { ModelChoice, SessionCommandInfo } from '#/sessions/api';
import {
  buildImagePreviewUrl,
  composerAttachmentsReducer,
  fallbackImageName,
  readyAttachments,
  revokePreviewUrl,
  uploadImage,
  type ComposerAttachment,
  type UploadedImage,
} from '#/sessions/files';
import { commitDraftEffort, draftEffortFor, segmentsFor } from '#/sessions/thinking';
import { CommandHint, commandHints, fillFor, hintSource, planHintKey } from './CommandHint';
import { ModelPicker, planPickerKey } from './ModelPicker';
import { errorMessage, Spinner } from './ui';

// ------------------------------------------------------------------ pure plan

export interface EnterKeyEventish {
  readonly key: string;
  readonly shiftKey: boolean;
  /** `KeyboardEvent.nativeEvent.isComposing` (true mid-IME). */
  readonly isComposing?: boolean;
  /** A send is already in flight. */
  readonly sending?: boolean;
}

/** Enter → 'send' only for a bare, non-composing, non-reentrant press. */
export function planSendOnEnter(event: EnterKeyEventish): 'send' | 'noop' {
  if (event.key !== 'Enter') return 'noop';
  if (event.shiftKey) return 'noop';
  if (event.isComposing === true) return 'noop';
  if (event.sending === true) return 'noop';
  return 'send';
}

export interface ComposerKeyEventish {
  readonly key: string;
  /** `KeyboardEvent.nativeEvent.isComposing` (true mid-IME). */
  readonly isComposing?: boolean;
  /** A turn is running — Escape aborts it; otherwise Escape is a noop. */
  readonly busy: boolean;
}

/**
 * Escape inside the composer (TUI parity): while a turn runs it aborts the
 * turn. The DRAFT STAYS untouched — unlike the TUI's queue-move, the hub
 * keeps typed text as-is and lets the engine's queue carry submitted
 * prompts. Mid-IME Escape (composition cancel) and idle sessions noop.
 */
export function planComposerKey(event: ComposerKeyEventish): 'abort-turn' | 'noop' {
  if (event.key !== 'Escape') return 'noop';
  if (event.isComposing === true) return 'noop';
  if (!event.busy) return 'noop';
  return 'abort-turn';
}

export interface ClipboardItemish {
  readonly kind: string;
  readonly type: string;
  readonly getAsFile?: () => File | null;
}

/**
 * The images a clipboard payload actually carries: `kind === 'file'` with an
 * `image/*` type and a readable blob. Paste is intercepted ONLY when this is
 * non-empty (plain-text paste must flow into the textarea).
 */
export function collectImagesFromClipboard(items: ArrayLike<ClipboardItemish>): File[] {
  const files: File[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined || item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile?.();
    if (file !== null && file !== undefined) files.push(file);
  }
  return files;
}

export type ComposerPlan =
  /** Nothing to send (empty input and no ready attachments). */
  | { readonly kind: 'noop' }
  /** Attachments still in flight — the Send button shows "Uploading…". */
  | { readonly kind: 'blocked-uploading' }
  | { readonly kind: 'command'; readonly action: ComposerAction }
  | { readonly kind: 'send'; readonly text: string };

/**
 * The send/slash boundary, decided from plain state. Slash input is always a
 * command (forwarded or local) and wins over anything else — attachments are
 * NOT part of a command and stay put. Otherwise: nothing → noop, uploads in
 * flight → blocked, else send the trimmed text (may be '' with images = an
 * image-only prompt).
 */
export function planComposerAction(state: {
  readonly input: string;
  readonly uploadingCount: number;
  readonly readyCount: number;
}): ComposerPlan {
  const text = state.input.trim();
  const command = parseComposerCommand(text);
  if (command === null) {
    if (text === '' && state.readyCount === 0) return { kind: 'noop' };
    if (state.uploadingCount > 0) return { kind: 'blocked-uploading' };
    return { kind: 'send', text };
  }
  return { kind: 'command', action: command.action };
}

// ------------------------------------------------------------------ component

/** ~5 rows at text-[16px]/leading-6 plus padding; beyond that, inner scroll. */
const MAX_TEXTAREA_HEIGHT = 152;

let attachmentCounter = 0;

function nextAttachmentId(): string {
  attachmentCounter += 1;
  return `att-${Date.now().toString(36)}-${attachmentCounter}`;
}

function formatKB(size: number): string {
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

export function Composer({
  busy,
  baseUrl,
  token,
  commandCatalog,
  modelPicker,
  onSend,
  onAbort,
  onCommand,
  draftRequest,
}: {
  busy: boolean;
  /** Agent proxy base + hub token, for image upload/preview fetches. */
  baseUrl: string;
  token: string;
  /** The agent's slash-command catalog (`GET …/commands`) feeding the hint popover. */
  commandCatalog: readonly SessionCommandInfo[];
  /**
   * Feeds the `/model` dialog (ModelPicker): the agent's model catalog plus
   * the live binding. Absent (catalog unavailable) → `/model` keeps its old
   * short-circuit notice path.
   */
  modelPicker?: {
    readonly models: readonly ModelChoice[];
    readonly currentModel?: string | undefined;
    readonly currentEffort?: string | undefined;
    readonly saving: boolean;
    readonly onApply: (model: string, effort: string) => Promise<void>;
  };
  onSend: (text: string, images: readonly UploadedImage[], steer?: boolean) => Promise<{ status: 'running' | 'queued' | 'blocked' }>;
  onAbort: () => Promise<void>;
  onCommand: (action: ComposerAction) => Promise<void>;
  /**
   * A recalled queued prompt, dropped in from the queue strip. `nonce` makes
   * each recall a one-shot (same text recalled twice still lands twice); an
   * in-progress draft is preserved by appending on a new line.
   */
  draftRequest?: { text: string; nonce: number } | null;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [queuedHint, setQueuedHint] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attachments, dispatch] = useReducer(composerAttachmentsReducer, [] as readonly ComposerAttachment[]);
  const [dragOver, setDragOver] = useState(false);
  // Hint popover: hidden while the popover was Esc-closed or filled for THIS
  // exact input — any further edit reopens it on the next slash word.
  const [hintDismissedFor, setHintDismissedFor] = useState<string | null>(null);
  const [hintIndex, setHintIndex] = useState(0);
  // `/model` dialog (ModelPicker): opened by SUBMITTING the bare command
  // (Enter on `/model`), not while typing; closed by Esc/✕/an apply. Holds
  // the highlighted row (null = follow the live model) + per-alias
  // draft-effort overrides from ←/→ stepping.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const [pickerEffortDrafts, setPickerEffortDrafts] = useState<Record<string, string>>({});

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pasteCounterRef = useRef(0);
  /** Latest attachments for the unmount cleanup (revoke dangling object URLs). */
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  /** Latest input for the draftRequest effect (keeps it off the dep list). */
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  // Recalled queue entries land here: append to an in-progress draft (new
  // line) instead of clobbering it, fill an empty composer outright, and
  // focus. `nonce` dedups a re-render storm but not two real recalls.
  const draftNonceRef = useRef(0);
  useEffect(() => {
    if (draftRequest === undefined || draftRequest === null) return;
    if (draftRequest.nonce <= draftNonceRef.current) return;
    draftNonceRef.current = draftRequest.nonce;
    const prev = inputRef.current;
    const next =
      prev.trim() === ''
        ? draftRequest.text
        : draftRequest.text.trim() === ''
          ? prev
          : `${prev}\n${draftRequest.text}`;
    setInput(next);
    if (next.startsWith('/')) setHintDismissedFor(next);
    textareaRef.current?.focus();
  }, [draftRequest]);

  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length;
  const ready = readyAttachments(attachments);
  const plan = planComposerAction({ input, uploadingCount, readyCount: ready.length });

  const hints = commandHints(input, hintSource(commandCatalog));
  const hintOpen = hints.length > 0 && !sending && hintDismissedFor !== input;
  useEffect(() => {
    if (hintIndex >= hints.length) setHintIndex(0);
  }, [hintIndex, hints.length]);

  // `/model` dialog rows: the full agent catalog (no filtering — submitting
  // the bare command opened the dialog; input stays free for real prompts).
  const pickerModels = modelPicker?.models ?? [];
  // `null` = no explicit ↑/↓ cursor yet — the highlight follows the LIVE model
  // (TUI parity: the dialog opens on the current row).
  const pickerActive = Math.min(
    pickerIndex ??
      Math.max(
        pickerModels.findIndex((model) => model.id === modelPicker?.currentModel),
        0,
      ),
    Math.max(pickerModels.length - 1, 0),
  );

  /** Open the dialog (bare `/model` submit); a no-catalog session keeps the notice fallback. */
  const openPicker = (): void => {
    setPickerIndex(null);
    setPickerOpen(true);
    textareaRef.current?.focus();
  };

  /** Close without applying (Esc / ✕): the draft cursor resets for the next open. */
  const closePicker = (): void => {
    setPickerOpen(false);
    setPickerIndex(null);
    textareaRef.current?.focus();
  };

  const pickerDraftOf = (model: ModelChoice): string =>
    draftEffortFor(model, {
      override: pickerEffortDrafts[model.id],
      liveEffort: model.id === modelPicker?.currentModel ? modelPicker.currentEffort : undefined,
    });

  /** ←/→ cycle the highlighted row's draft (TUI parity: 2 segments flip, more clamp). */
  const stepPickerEffort = (delta: 1 | -1): void => {
    const row = pickerModels[pickerActive];
    if (row === undefined) return;
    const segments = segmentsFor(row);
    if (segments.length < 2) return;
    const idx = segments.indexOf(pickerDraftOf(row));
    const next = segments.length === 2 ? segments[idx === 0 ? 1 : 0] : segments[idx + delta];
    if (next === undefined) return;
    setPickerEffortDrafts((drafts) => ({ ...drafts, [row.id]: next }));
  };

  /** Enter / row-click: commit { model, committedDraftEffort } and close the dialog. */
  const applyPickerRow = async (row: ModelChoice): Promise<void> => {
    if (modelPicker === undefined) return;
    const effort = commitDraftEffort(row, pickerDraftOf(row));
    setError(null);
    setPickerOpen(false);
    setPickerIndex(null);
    try {
      await modelPicker.onApply(row.id, effort);
    } catch (error) {
      setError(error);
    }
  };

  const acceptHint = (candidate: (typeof hints)[number]): void => {
    const fill = fillFor(candidate);
    setInput(fill);
    setHintDismissedFor(fill);
    textareaRef.current?.focus();
  };

  // Auto-grow: recompute height on every value change (JS, not CSS rows=).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [input]);

  // Revoke every dangling object URL on unmount.
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl !== undefined) revokePreviewUrl(attachment.previewUrl);
      }
    },
    [],
  );

  const runUpload = async (attachment: ComposerAttachment): Promise<void> => {
    try {
      const uploaded = await uploadImage({
        baseUrl,
        token,
        file: attachment.file,
        fileName: attachment.name,
      });
      dispatch({ type: 'resolve', localId: attachment.localId, fileId: uploaded.id });
      // Best-effort thumbnail: a failed read-back just leaves the name chip.
      try {
        const previewUrl = await buildImagePreviewUrl({ baseUrl, token, fileId: uploaded.id });
        dispatch({ type: 'preview', localId: attachment.localId, previewUrl });
      } catch {
        // no thumbnail — the name+size chip is enough
      }
    } catch (error) {
      dispatch({ type: 'fail', localId: attachment.localId, error: errorMessage(error) });
    }
  };

  const addFiles = (files: readonly File[], source: 'paste' | 'drop'): void => {
    for (const file of files) {
      let name = file.name;
      if (source === 'paste' || name === '') {
        pasteCounterRef.current += 1;
        name = fallbackImageName(pasteCounterRef.current, file.type);
      }
      const attachment: ComposerAttachment = {
        localId: nextAttachmentId(),
        name,
        size: file.size,
        mediaType: file.type,
        file,
        status: 'uploading',
      };
      dispatch({ type: 'add', attachment });
      void runUpload(attachment);
    }
    textareaRef.current?.focus();
  };

  const removeAttachment = (localId: string): void => {
    const target = attachments.find((a) => a.localId === localId);
    if (target?.previewUrl !== undefined) revokePreviewUrl(target.previewUrl);
    dispatch({ type: 'remove', localId });
  };

  const clearAttachments = (): void => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.previewUrl !== undefined) revokePreviewUrl(attachment.previewUrl);
    }
    dispatch({ type: 'clear' });
  };

  const send = async (steer = false) => {
    if (sending) return;
    switch (plan.kind) {
      case 'noop':
      case 'blocked-uploading':
        return;
      case 'command': {
        // Bare `/model` OPENS the page's model dialog instead of dispatching:
        // the TUI's own dialog can't render over the hub (it would pop the
        // host's screen). A session whose catalog is unavailable keeps the
        // short-circuit-notice fallback; `/model <args>` still forwards to
        // the agent's command bridge as before.
        // Commands are never steerable — steer carries a PROMPT, not a
        // dispatch; the Steer button stays disabled for a command plan.
        if (steer) return;
        if (input.trim() === '/model' && modelPicker !== undefined && modelPicker.models.length > 0) {
          setInput('');
          openPicker();
          return;
        }
        const text = input.trim();
        setSending(true);
        setError(null);
        setInput('');
        try {
          setCommandBusy(true);
          try {
            await onCommand(plan.action);
          } finally {
            setCommandBusy(false);
          }
        } catch (error) {
          setError(error);
          setInput(text);
        } finally {
          setSending(false);
        }
        return;
      }
      case 'send': {
        const text = plan.text;
        setSending(true);
        setError(null);
        // Optimistic clear, text and chips together (TUI parity): a stall or
        // failure of onSend must not leave the composer half-closed. On error
        // the text comes back for a retry; chips don't — their bytes are
        // already in the agent's file store, re-attaching is one paste away.
        setInput('');
        clearAttachments();
        try {
          const result = await onSend(text, ready, steer);
          if (result.status !== 'running') setQueuedHint(true);
        } catch (error) {
          setError(error);
          setInput(text);
        } finally {
          setSending(false);
        }
        return;
      }
    }
  };

  return (
    <div
      className={`relative border-t border-neutral-800 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${
        dragOver ? 'bg-neutral-900/40' : ''
      }`}
      onDragOver={(e) => {
        // Only advertise a drop when at least one image is offered.
        if (collectImagesFromClipboard(e.dataTransfer.items).length > 0) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Ignore transitions into a child; clear only when truly leaving.
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        setDragOver(false);
        const images = collectImagesFromClipboard(e.dataTransfer.items);
        if (images.length === 0) return;
        e.preventDefault();
        addFiles(images, 'drop');
      }}
    >
      {hintOpen ? <CommandHint active={hintIndex} candidates={hints} onAccept={acceptHint} /> : null}
      {pickerOpen && modelPicker !== undefined ? (
        <ModelPicker
          models={pickerModels}
          currentModel={modelPicker.currentModel}
          currentEffort={modelPicker.currentEffort}
          active={pickerActive}
          effortDrafts={pickerEffortDrafts}
          disabled={modelPicker.saving}
          onApply={(model, effort) => {
            setPickerOpen(false);
            setPickerIndex(null);
            void modelPicker.onApply(model, effort).catch(setError);
          }}
          onClose={closePicker}
        />
      ) : null}

      {/* -------------------------------------------- attachment chips */}
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <div
              key={attachment.localId}
              className={`flex min-h-[40px] items-center gap-1.5 rounded border px-1.5 py-1 ${
                attachment.status === 'failed'
                  ? 'border-red-900/70 bg-red-950/30'
                  : 'border-neutral-700 bg-neutral-950'
              }`}
            >
              {attachment.previewUrl !== undefined ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : attachment.status === 'uploading' ? (
                <span className="flex h-8 w-8 items-center justify-center">
                  <Spinner />
                </span>
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded bg-neutral-800 text-[10px] text-neutral-500">
                  img
                </span>
              )}
              <span className="min-w-0">
                <span
                  className={`block max-w-36 truncate text-[11px] ${
                    attachment.status === 'failed' ? 'text-red-300' : 'text-neutral-300'
                  }`}
                >
                  {attachment.name}
                </span>
                <span className="block text-[9px] text-neutral-600">
                  {attachment.status === 'failed'
                    ? (attachment.error ?? 'upload failed')
                    : `${formatKB(attachment.size)}${attachment.status === 'uploading' ? ' · uploading…' : ''}`}
                </span>
              </span>
              {attachment.status === 'failed' ? (
                <button
                  className="min-h-[28px] rounded px-1 text-[11px] text-sky-400 hover:bg-neutral-800"
                  title="retry the upload (once)"
                  onClick={() => {
                    dispatch({ type: 'retry', localId: attachment.localId });
                    void runUpload({ ...attachment, status: 'uploading', error: undefined });
                  }}
                >
                  Retry
                </button>
              ) : null}
              <button
                className="min-h-[28px] rounded px-1 text-[13px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
                title="remove attachment"
                onClick={() => {
                  removeAttachment(attachment.localId);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          className={`min-h-[40px] flex-1 resize-none rounded border bg-neutral-950 px-3 py-2 text-[16px] leading-6 text-neutral-100 outline-none focus:border-sky-600 lg:text-[14px] lg:leading-5 ${
            dragOver ? 'border-dashed border-sky-700' : 'border-neutral-700'
          }`}
          placeholder={
            busy
              ? 'The agent is working — your message is queued…'
              : attachments.length > 0
                ? 'Add a caption… (Enter to send)'
                : 'Send a prompt… (Enter to send, Shift+Enter for newline, paste or drop images)'
          }
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setQueuedHint(false);
          }}
          onKeyDown={(e) => {
            // The `/model` dialog wins every key while open (like the hint
            // popover) — including Escape, whose turn-abort binding only
            // applies once it's closed. Typing keeps working though: any
            // non-picker key still lands in the textarea while it is up.
            if (pickerOpen) {
              const pickerAction = planPickerKey({
                key: e.key,
                isComposing: e.nativeEvent.isComposing,
              });
              if (pickerAction.kind === 'move') {
                e.preventDefault();
                setPickerIndex(
                  (pickerActive + pickerAction.delta + pickerModels.length) % pickerModels.length,
                );
                return;
              }
              if (pickerAction.kind === 'effort') {
                e.preventDefault();
                stepPickerEffort(pickerAction.delta);
                return;
              }
              if (pickerAction.kind === 'apply') {
                const row = pickerModels[pickerActive];
                if (row !== undefined) {
                  e.preventDefault();
                  void applyPickerRow(row);
                  return;
                }
              }
              if (pickerAction.kind === 'close') {
                e.preventDefault();
                e.stopPropagation();
                closePicker();
                return;
              }
            }
            // Hint popover wins every key while open — including Escape, whose
            // turn-abort binding only applies once it's closed.
            if (hintOpen) {
              const hintAction = planHintKey({
                key: e.key,
                isComposing: e.nativeEvent.isComposing,
              });
              if (hintAction.kind === 'move') {
                e.preventDefault();
                setHintIndex((index) => (index + hintAction.delta + hints.length) % hints.length);
                return;
              }
              if (hintAction.kind === 'accept') {
                e.preventDefault();
                acceptHint(hints[Math.min(hintIndex, hints.length - 1)]!);
                return;
              }
              if (hintAction.kind === 'close') {
                e.preventDefault();
                e.stopPropagation();
                setHintDismissedFor(input);
                return;
              }
            }
            // Esc aborts the running turn — swallowed by the pane-level
            // keymap too, so stop propagation to fire exactly once.
            if (
              planComposerKey({
                key: e.key,
                isComposing: e.nativeEvent.isComposing,
                busy,
              }) === 'abort-turn'
            ) {
              e.preventDefault();
              e.stopPropagation();
              void onAbort().catch(setError);
              return;
            }
            if (
              planSendOnEnter({
                key: e.key,
                shiftKey: e.shiftKey,
                isComposing: e.nativeEvent.isComposing,
                sending,
              }) === 'send'
            ) {
              e.preventDefault();
              void send();
            }
          }}
          onPaste={(e) => {
            const images = collectImagesFromClipboard(e.clipboardData.items);
            if (images.length === 0) return; // plain-text paste flows through
            e.preventDefault();
            addFiles(images, 'paste');
          }}
        />
        {/* While busy the slot holds two buttons: Steer injects the typed
            text into the running turn at the next step boundary (server-side
            degrade = plain queue/launch when there is nothing to steer into);
            Stop aborts the turn. Plain queueing is still available via Enter
            (engine-side) — the queuedHint line says so after such a send. */}
        {busy ? (
          <>
            <button
              className="flex min-h-[40px] items-center justify-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
              disabled={sending || plan.kind !== 'send'}
              title="send now, injected into the running turn (steer)"
              onClick={() => void send(true)}
            >
              {sending ? 'Sending…' : 'Steer'}
            </button>
            <button
              className="flex min-h-[40px] items-center justify-center gap-1.5 rounded border border-red-900/70 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-950/60"
              onClick={() => {
                void onAbort().catch(setError);
              }}
            >
              Stop
            </button>
          </>
        ) : (
          <button
            className="flex min-h-[40px] items-center justify-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
            disabled={sending || plan.kind === 'noop' || plan.kind === 'blocked-uploading'}
            onClick={() => void send()}
          >
            {plan.kind === 'blocked-uploading' ? (
              <>
                <Spinner light /> Uploading…
              </>
            ) : sending ? (
              'Sending…'
            ) : (
              'Send'
            )}
          </button>
        )}
      </div>

      {commandBusy ? (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-neutral-500 italic">
          <Spinner />
          running command…
        </div>
      ) : null}
      {queuedHint ? (
        <div className="mt-1 text-[10px] text-neutral-500 italic">
          queued — will run after the current turn
        </div>
      ) : null}
      {error !== null ? (
        <div className="mt-1 rounded bg-red-950/50 px-2 py-1 text-[11px] text-red-400">
          {errorMessage(error)}
        </div>
      ) : null}
    </div>
  );
}
