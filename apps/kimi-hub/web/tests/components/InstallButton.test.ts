import { describe, expect, it } from 'vitest';

import { installHintKind } from '#/components/InstallButton';

describe('installHintKind', () => {
  it('hides when already running standalone', () => {
    expect(
      installHintKind({ alreadyStandalone: true, hasDeferredPrompt: true, isIosSafari: true }),
    ).toBe('hidden');
  });

  it('prefers the native prompt when the browser offers one', () => {
    expect(
      installHintKind({ alreadyStandalone: false, hasDeferredPrompt: true, isIosSafari: false }),
    ).toBe('native-prompt');
  });

  it('falls back to the Safari guide on iOS without a deferred prompt', () => {
    expect(
      installHintKind({ alreadyStandalone: false, hasDeferredPrompt: false, isIosSafari: true }),
    ).toBe('ios-guide');
  });

  it('hides elsewhere (desktop Chrome without a deferred prompt)', () => {
    expect(
      installHintKind({ alreadyStandalone: false, hasDeferredPrompt: false, isIosSafari: false }),
    ).toBe('hidden');
  });
});
