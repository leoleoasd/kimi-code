import { describe, expect, it } from 'vitest';

import { mediaUrlPartToText, summarizeDataUrl } from '#/tui/utils/media-url';

describe('mediaUrlPartToText', () => {
  it('keeps non-data URLs as escaped XML-like references', () => {
    expect(mediaUrlPartToText('image', 'file:///tmp/a&b".png')).toBe(
      '<image url="file:///tmp/a&amp;b&quot;.png">',
    );
  });

  it('renders an internal daemon file reference as a bare placeholder', () => {
    // `kimi-file://…?path=…` resolves nowhere for the user and carries the
    // materialization path — never render the wire form.
    expect(
      mediaUrlPartToText('image', 'kimi-file://f_1?path=%2FUsers%2Falice%2Fmedia%2Ff_1.png'),
    ).toBe('[image]');
    expect(mediaUrlPartToText('video', 'kimi-file://f_2')).toBe('[video]');
  });

  it('summarizes base64 data URLs without returning the payload', () => {
    expect(mediaUrlPartToText('image', 'data:image/png;base64,qrs=')).toBe(
      '[image image/png, 2 B]',
    );
  });

  it('formats larger base64 payload sizes compactly', () => {
    const oneKib = 'A'.repeat(1368);
    expect(mediaUrlPartToText('video', `data:video/mp4;base64,${oneKib}`)).toBe(
      '[video video/mp4, 1.0 KB]',
    );
  });

  it('marks engine blob-store refs by mime without a size', () => {
    expect(mediaUrlPartToText('image', 'blobref:image/png;abc123def456')).toBe(
      '[image image/png]',
    );
    expect(mediaUrlPartToText('video', 'blobref:video/mp4;deadbeef')).toBe('[video video/mp4]');
  });

  it('falls back to the escaped reference for a blobref without a mime', () => {
    expect(mediaUrlPartToText('image', 'blobref:;abc123')).toBe('<image url="blobref:;abc123">');
  });
});

describe('summarizeDataUrl', () => {
  it('returns undefined for regular URLs', () => {
    expect(summarizeDataUrl('https://example.com/a.png')).toBeUndefined();
  });

  it('parses MIME and decoded byte count for base64 data URLs', () => {
    expect(summarizeDataUrl('data:image/png;base64,AQIDBA==')).toEqual({
      mime: 'image/png',
      bytes: 4,
    });
  });
});
