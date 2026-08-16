/**
 * Composer decision logic — headless: Enter/IME planning, clipboard image
 * collection, and the send/slash boundary (`planComposerAction`). The DOM
 * side is not covered (this package has no component-test harness).
 */

import { describe, expect, it } from 'vitest';

import {
  collectImagesFromClipboard,
  planComposerAction,
  planComposerKey,
  planSendOnEnter,
  type ClipboardItemish,
} from './Composer';

describe('planSendOnEnter', () => {
  it('plain Enter sends', () => {
    expect(planSendOnEnter({ key: 'Enter', shiftKey: false })).toBe('send');
  });

  it('Shift+Enter is a newline, never a send', () => {
    expect(planSendOnEnter({ key: 'Enter', shiftKey: true })).toBe('noop');
  });

  it('never sends while an IME composition is active (candidate selection)', () => {
    expect(planSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe('noop');
  });

  it('a send already in flight is not re-entered', () => {
    expect(planSendOnEnter({ key: 'Enter', shiftKey: false, sending: true })).toBe('noop');
  });

  it('other keys never send', () => {
    expect(planSendOnEnter({ key: 'j', shiftKey: false })).toBe('noop');
    expect(planSendOnEnter({ key: 'Escape', shiftKey: false })).toBe('noop');
  });
});

describe('planComposerKey', () => {
  // The full Escape truth table — composing (IME) × busy:
  //   not composing + busy     → abort-turn
  //   composing     + busy     → noop (Esc cancels the IME composition)
  //   not composing + not busy → noop (nothing to abort)
  //   composing     + not busy → noop
  it('Escape aborts only while a turn is running and no IME is active', () => {
    expect(planComposerKey({ key: 'Escape', busy: true })).toBe('abort-turn');
    expect(planComposerKey({ key: 'Escape', busy: true, isComposing: false })).toBe('abort-turn');
    expect(planComposerKey({ key: 'Escape', busy: false })).toBe('noop');
    expect(planComposerKey({ key: 'Escape', busy: false, isComposing: false })).toBe('noop');
  });

  it('an active IME composition swallows Escape (busy or not)', () => {
    expect(planComposerKey({ key: 'Escape', busy: true, isComposing: true })).toBe('noop');
    expect(planComposerKey({ key: 'Escape', busy: false, isComposing: true })).toBe('noop');
  });

  it('non-Escape keys never abort, however busy', () => {
    expect(planComposerKey({ key: 'Enter', busy: true })).toBe('noop');
    expect(planComposerKey({ key: 'a', busy: true })).toBe('noop');
  });
});

describe('collectImagesFromClipboard', () => {
  const file = new File(['bytes'], 'image.png', { type: 'image/png' });

  function item(kind: string, type: string, asFile: File | null = file): ClipboardItemish {
    return { kind, type, getAsFile: () => asFile };
  }

  it('collects image file items', () => {
    expect(collectImagesFromClipboard([item('file', 'image/png')])).toEqual([file]);
  });

  it('ignores plain-text and non-image items', () => {
    expect(collectImagesFromClipboard([item('string', 'text/plain')])).toEqual([]);
    expect(collectImagesFromClipboard([item('file', 'application/pdf')])).toEqual([]);
  });

  it('drops items whose blob cannot be read', () => {
    expect(collectImagesFromClipboard([item('file', 'image/png', null)])).toEqual([]);
  });

  it('keeps order across a mixed payload', () => {
    const second = new File(['x'], 'shot.jpg', { type: 'image/jpeg' });
    const items = [item('string', 'text/plain'), item('file', 'image/jpeg', second), item('file', 'image/png')];
    expect(collectImagesFromClipboard(items)).toEqual([second, file]);
  });
});

describe('planComposerAction', () => {
  const naked = { uploadingCount: 0, readyCount: 0 };

  it('empty input with nothing attached is a noop', () => {
    expect(planComposerAction({ input: '  ', ...naked })).toEqual({ kind: 'noop' });
  });

  it('plain text sends, trimmed', () => {
    expect(planComposerAction({ input: '  hi there  ', ...naked })).toEqual({
      kind: 'send',
      text: 'hi there',
    });
  });

  it('an image-only body sends with empty text', () => {
    expect(planComposerAction({ input: '', uploadingCount: 0, readyCount: 1 })).toEqual({
      kind: 'send',
      text: '',
    });
  });

  it('uploads in flight block the send (spinner state)', () => {
    expect(planComposerAction({ input: 'look at this', uploadingCount: 1, readyCount: 1 })).toEqual({
      kind: 'blocked-uploading',
    });
  });

  it('slash lines become commands regardless of attachments', () => {
    expect(planComposerAction({ input: '/abort', uploadingCount: 1, readyCount: 2 })).toEqual({
      kind: 'command',
      action: { kind: 'remote', input: '/abort' },
    });
    expect(planComposerAction({ input: '/compact keep the API bits', ...naked })).toEqual({
      kind: 'command',
      action: { kind: 'remote', input: '/compact keep the API bits' },
    });
  });

  it('unknown slash input forwards too — the agent judges it, never the composer', () => {
    expect(planComposerAction({ input: '/restart', ...naked })).toEqual({
      kind: 'command',
      action: { kind: 'remote', input: '/restart' },
    });
  });

  it('the local pair parses to its own actions', () => {
    expect(planComposerAction({ input: '/copy', ...naked })).toEqual({
      kind: 'command',
      action: { kind: 'copy' },
    });
    expect(planComposerAction({ input: '/export-debug-zip', ...naked })).toEqual({
      kind: 'command',
      action: { kind: 'export-debug-zip' },
    });
  });

  it('text merely mentioning /commands sends as a prompt', () => {
    expect(planComposerAction({ input: 'explain what /abort does', ...naked })).toEqual({
      kind: 'send',
      text: 'explain what /abort does',
    });
  });
});
