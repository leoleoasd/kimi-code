/**
 * "Install to Home Screen" affordance for the header: mobile-friendly path to
 * a standalone launch. Native prompt when the browser offers one (Android
 * Chrome via `beforeinstallprompt`); otherwise a tiny guide popover —
 * Safari's "Add to Home Screen" lives behind the Share sheet and has no
 * programmatic prompt, so the button explains where it is.
 *
 * Pure detection (`installHintKind`) stays headless-testable.
 */

import { useEffect, useState } from 'react';

export type InstallHintKind = 'native-prompt' | 'ios-guide' | 'hidden';

/** What the install button should do, fully determined by the environment. */
export function installHintKind(env: {
  readonly alreadyStandalone: boolean;
  readonly hasDeferredPrompt: boolean;
  readonly isIosSafari: boolean;
}): InstallHintKind {
  if (env.alreadyStandalone) return 'hidden';
  if (env.hasDeferredPrompt) return 'native-prompt';
  if (env.isIosSafari) return 'ios-guide';
  return env.hasDeferredPrompt ? 'native-prompt' : 'hidden';
}

interface BeforeInstallPromptEventLike {
  prompt(): Promise<void>;
}

export function InstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEventLike | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  useEffect(() => {
    const listener = (event: Event) => {
      event.preventDefault();
      setDeferred(event as unknown as BeforeInstallPromptEventLike);
    };
    window.addEventListener('beforeinstallprompt', listener);
    return () => {
      window.removeEventListener('beforeinstallprompt', listener);
    };
  }, []);

  const navStandalone = (navigator as unknown as { standalone?: unknown }).standalone;
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navStandalone === true;
  const kind = installHintKind({
    alreadyStandalone: standalone,
    hasDeferredPrompt: deferred !== null,
    isIosSafari: /iphone|ipad|ipod/i.test(navigator.userAgent),
  });
  if (kind === 'hidden') return null;

  return (
    <span className="relative">
      <button
        type="button"
        className="flex min-h-[36px] items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
        title="install as a Home Screen app"
        onClick={() => {
          if (kind === 'native-prompt' && deferred !== null) {
            void deferred.prompt();
            setDeferred(null);
            return;
          }
          setShowGuide((value) => !value);
        }}
      >
        Install app
      </button>
      {showGuide ? (
        <span className="absolute right-0 top-full z-10 mt-1 w-60 rounded border border-neutral-700 bg-neutral-900 p-2 text-[11px] leading-5 text-neutral-300 shadow-lg">
          Safari 打开本页 → 底部 分享 → 添加到主屏幕。
        </span>
      ) : null}
    </span>
  );
}
