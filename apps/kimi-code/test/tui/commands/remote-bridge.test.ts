/**
 * The remote command bridge: remote lines run the TUI's OWN dispatch
 * (`runSlashCommand`), the surfaced lines come back as the wire result, and a
 * line for any session the TUI is not showing is refused up front.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { runSlashCommand } from '#/tui/commands/dispatch';
import { createTuiCommandBridge } from '#/tui/commands/remote-bridge';

interface FakeHostOptions {
  readonly sessionId?: string;
  readonly permissionMode?: 'manual' | 'yolo' | 'auto';
}

function makeHost(options: FakeHostOptions = {}): SlashCommandHost & {
  showStatus: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  showNotice: ReturnType<typeof vi.fn>;
  setAppState: ReturnType<typeof vi.fn>;
  sendNormalUserInput: ReturnType<typeof vi.fn>;
  setPermission: ReturnType<typeof vi.fn>;
} {
  const setPermission = vi.fn(async () => {});
  const host = {
    session:
      options.sessionId === undefined ? undefined : { id: options.sessionId, setPermission },
    state: {
      appState: {
        permissionMode: options.permissionMode ?? 'manual',
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi-k2',
      },
    },
    skillCommandMap: new Map([['write-tui', 'write-tui']]),
    pluginCommandMap: new Map(),
    track: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    setAppState: vi.fn(),
    sendNormalUserInput: vi.fn(),
  };
  return { ...host, setPermission } as unknown as ReturnType<typeof makeHost>;
}

describe('createTuiCommandBridge', () => {
  it('runs a builtin command through the real dispatch and captures the surfaced lines', async () => {
    const host = makeHost({ sessionId: 'ses-1' });
    const bridge = createTuiCommandBridge(host, runSlashCommand);
    const result = await bridge.execute('ses-1', '/yolo on');
    expect(result.errors).toEqual([]);
    expect(result.notices.some((line) => line.includes('YOLO mode: ON'))).toBe(true);
    // The notice ALSO lands on the TUI itself (visible remote actions).
    expect(host.showNotice).toHaveBeenCalledWith('YOLO mode: ON', expect.stringContaining('auto-approved'));
    expect(host.setPermission).toHaveBeenCalledWith('yolo');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('refuses a session the TUI is not showing — never applies to the wrong one', async () => {
    const host = makeHost({ sessionId: 'ses-1' });
    const bridge = createTuiCommandBridge(host, runSlashCommand);
    const result = await bridge.execute('ses-OTHER', '/yolo on');
    expect(result.notices).toEqual([]);
    expect(result.errors[0]).toContain('ses-1');
    expect(host.setPermission).not.toHaveBeenCalled();
  });

  it('refuses plainly when the TUI has no session at all', async () => {
    const host = makeHost();
    const bridge = createTuiCommandBridge(host, runSlashCommand);
    const result = await bridge.execute('ses-1', '/yolo on');
    expect(result.errors[0]).toContain('not showing any session');
  });

  it('forwards unknown words into the dispatch (message fallthrough) instead of judging them itself', async () => {
    const host = makeHost({ sessionId: 'ses-1' });
    const bridge = createTuiCommandBridge(host, runSlashCommand);
    const result = await bridge.execute('ses-1', '/no-such-command ever');
    // The TUI's own rule: unknown slash input falls through as a normal message.
    expect(result.errors).toEqual([]);
    expect(host.sendNormalUserInput).toHaveBeenCalled();
  });

  it('catalog = the builtin registry + the session skill map (+ plugin map)', () => {
    const host = makeHost({ sessionId: 'ses-1' });
    const names = createTuiCommandBridge(host, runSlashCommand)
      .catalog()
      .map((row) => row.name);
    expect(names).toContain('yolo');
    expect(names).toContain('plan');
    expect(names).toContain('write-tui');
    const yolo = createTuiCommandBridge(host, runSlashCommand)
      .catalog()
      .find((row) => row.name === 'yolo');
    expect(yolo?.aliases).toContain('yes');
  });
});
