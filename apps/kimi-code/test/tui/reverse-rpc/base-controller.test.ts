import { describe, expect, it, vi } from 'vitest';

import { ReverseRpcController } from '#/tui/reverse-rpc/base-controller';

class TestController extends ReverseRpcController<string, string> {
  protected createCancelResponse(reason: string): string {
    return `cancel:${reason}`;
  }

  protected idOf(payload: string): string {
    return payload;
  }
}

describe('ReverseRpcController', () => {
  it('shows a payload, resolves the pending promise on respond, and hides the panel', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const pending = controller.show('payload');
    expect(controller.hasPending()).toBe(true);
    expect(showPanel).toHaveBeenCalledWith('payload');

    controller.respond('approved');

    await expect(pending).resolves.toBe('approved');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledOnce();
  });

  it('queues concurrent show() requests and presents them one at a time', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    const third = controller.show('third');

    // Only the first is presented; the rest stay queued.
    expect(showPanel).toHaveBeenCalledTimes(1);
    expect(showPanel).toHaveBeenLastCalledWith('first');
    expect(controller.hasPending()).toBe(true);

    controller.respond('answer-first');
    await expect(first).resolves.toBe('answer-first');
    // Advancing to the next queued request reuses the same panel without
    // hiding it in between.
    expect(hidePanel).not.toHaveBeenCalled();
    expect(showPanel).toHaveBeenCalledTimes(2);
    expect(showPanel).toHaveBeenLastCalledWith('second');

    controller.respond('answer-second');
    await expect(second).resolves.toBe('answer-second');
    expect(showPanel).toHaveBeenCalledTimes(3);
    expect(showPanel).toHaveBeenLastCalledWith('third');

    controller.respond('answer-third');
    await expect(third).resolves.toBe('answer-third');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('auto-resolves matching queued requests via the autoResolveFor hook', async () => {
    class AutoController extends ReverseRpcController<
      { action: string; id: string },
      string
    > {
      protected createCancelResponse(reason: string): string {
        return `cancel:${reason}`;
      }
      protected idOf(payload: { action: string; id: string }): string {
        return payload.id;
      }
      protected override autoResolveFor(
        resolved: { action: string; id: string },
        response: string,
        queued: { action: string; id: string },
      ): string | undefined {
        if (response === 'approve_all_same' && resolved.action === queued.action) {
          return `auto:${queued.id}`;
        }
        return undefined;
      }
    }
    const controller = new AutoController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show({ action: 'run', id: 'a' });
    const second = controller.show({ action: 'run', id: 'b' });
    const third = controller.show({ action: 'edit', id: 'c' });
    const fourth = controller.show({ action: 'run', id: 'd' });

    controller.respond('approve_all_same');

    await expect(first).resolves.toBe('approve_all_same');
    await expect(second).resolves.toBe('auto:b');
    await expect(fourth).resolves.toBe('auto:d');
    // The non-matching request advances to the panel and stays pending.
    expect(showPanel).toHaveBeenLastCalledWith({ action: 'edit', id: 'c' });
    expect(controller.hasPending()).toBe(true);

    controller.respond('approve_all_same');
    await expect(third).resolves.toBe('approve_all_same');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('cancelAll cancels the current request and every queued request', async () => {
    const controller = new TestController();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel: vi.fn(), hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    const third = controller.show('third');

    controller.cancelAll('shutdown');

    await expect(first).resolves.toBe('cancel:shutdown');
    await expect(second).resolves.toBe('cancel:shutdown');
    await expect(third).resolves.toBe('cancel:shutdown');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('cancel() un-resolves only the matching panelled request and hides it', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');

    // The kernel interaction behind `first` resolved through another surface.
    controller.cancel('first');

    await expect(first).resolves.toBe('cancel:resolved through another surface');
    // The queued request advances to the panel.
    expect(showPanel).toHaveBeenLastCalledWith('second');
    expect(hidePanel).not.toHaveBeenCalled();
    expect(controller.hasPending()).toBe(true);

    controller.respond('answer-second');
    await expect(second).resolves.toBe('answer-second');
    expect(controller.hasPending()).toBe(false);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops the matching queued request without touching the panel', async () => {
    const controller = new TestController();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    controller.setUIHooks({ showPanel, hidePanel });

    const first = controller.show('first');
    const second = controller.show('second');
    controller.cancel('second');

    await expect(second).resolves.toBe('cancel:resolved through another surface');
    expect(showPanel).toHaveBeenCalledTimes(1);
    expect(hidePanel).not.toHaveBeenCalled();

    controller.cancel('no-such-id');
    expect(controller.hasPending()).toBe(true);
    controller.respond('answer-first');
    await expect(first).resolves.toBe('answer-first');
    expect(controller.hasPending()).toBe(false);
  });
});
