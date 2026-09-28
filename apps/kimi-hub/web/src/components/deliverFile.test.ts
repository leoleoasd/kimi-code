import { describe, expect, it } from 'vitest';

import {
  DELIVER_PREVIEW_CAPS,
  deliverFilePreviewKind,
  formatDeliverSize,
  resolveDeliverFileDisplay,
} from './deliverFile';

function frame(over: Partial<Parameters<typeof resolveDeliverFileDisplay>[0]>) {
  return { name: 'DeliverFile', ...over };
}

describe('resolveDeliverFileDisplay', () => {
  it('ignores other tools', () => {
    expect(resolveDeliverFileDisplay(frame({ name: 'Bash' }))).toBeUndefined();
  });

  it('running frame: path only, no file handle', () => {
    const display = resolveDeliverFileDisplay(
      frame({
        input: JSON.stringify({ path: '/ws/report.pdf' }),
        output: undefined,
      }),
    );
    expect(display).toEqual({ path: '/ws/report.pdf' });
  });

  it('prefers the resolved display path over raw args', () => {
    const display = resolveDeliverFileDisplay(
      frame({
        input: JSON.stringify({ path: 'report.pdf' }),
        display: { kind: 'file_io', operation: 'read', path: '/abs/report.pdf' },
        output: undefined,
      }),
    );
    expect(display).toEqual({ path: '/abs/report.pdf' });
  });

  it('parses the result JSON into a file handle', () => {
    const display = resolveDeliverFileDisplay(
      frame({
        input: JSON.stringify({ path: '/ws/report.pdf' }),
        output: JSON.stringify({
          file_id: 'f_abc123',
          name: 'report.pdf',
          media_type: 'application/pdf',
          size: 2048,
        }),
      }),
    );
    expect(display).toEqual({
      path: '/ws/report.pdf',
      fileId: 'f_abc123',
      name: 'report.pdf',
      mediaType: 'application/pdf',
      size: 2048,
    });
  });

  it('non-JSON output (tool error) falls back to the generic frame', () => {
    expect(
      resolveDeliverFileDisplay(
        frame({
          input: JSON.stringify({ path: '/ws/report.pdf' }),
          output: 'Cannot deliver "/ws/report.pdf": the file does not exist.',
        }),
      ),
    ).toBeUndefined();
  });

  it('result JSON without file_id falls back to the generic frame', () => {
    expect(
      resolveDeliverFileDisplay(
        frame({
          input: JSON.stringify({ path: '/ws/report.pdf' }),
          output: JSON.stringify({ ok: true }),
        }),
      ),
    ).toBeUndefined();
  });
});

describe('formatDeliverSize', () => {
  it('formats bytes / KB / MB', () => {
    expect(formatDeliverSize(512)).toBe('512 B');
    expect(formatDeliverSize(2048)).toBe('2.0 KB');
    expect(formatDeliverSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('deliverFilePreviewKind', () => {
  it('previews images, including svg', () => {
    expect(deliverFilePreviewKind('image/png', 100)).toBe('image');
    expect(deliverFilePreviewKind('image/svg+xml', 100)).toBe('image');
  });

  it('previews PDFs through the browser viewer', () => {
    expect(deliverFilePreviewKind('application/pdf', 1024 * 1024)).toBe('pdf');
  });

  it('previews text media types and structured text bodies', () => {
    expect(deliverFilePreviewKind('text/plain', 100)).toBe('text');
    expect(deliverFilePreviewKind('text/markdown', 17_800)).toBe('text');
    expect(deliverFilePreviewKind('application/json', 100)).toBe('text');
    expect(deliverFilePreviewKind('application/x-yaml', 100)).toBe('text');
    expect(deliverFilePreviewKind('application/atom+xml', 100)).toBe('text');
    expect(deliverFilePreviewKind('application/geo+json', 100)).toBe('text');
  });

  it('skips binary and oversized bodies, and unknown media types', () => {
    expect(deliverFilePreviewKind('application/octet-stream', 100)).toBeUndefined();
    expect(deliverFilePreviewKind('application/zip', 100)).toBeUndefined();
    expect(deliverFilePreviewKind(undefined, 100)).toBeUndefined();
    expect(deliverFilePreviewKind('text/plain', DELIVER_PREVIEW_CAPS.text + 1)).toBeUndefined();
    expect(deliverFilePreviewKind('text/plain', DELIVER_PREVIEW_CAPS.text)).toBe('text');
    expect(deliverFilePreviewKind('application/pdf', DELIVER_PREVIEW_CAPS.pdf + 1)).toBeUndefined();
    expect(deliverFilePreviewKind('image/png', DELIVER_PREVIEW_CAPS.image + 1)).toBeUndefined();
    expect(deliverFilePreviewKind('text/plain', undefined)).toBe('text');
  });
});
