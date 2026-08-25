/**
 * `/remote` slash-command behavior: the connection runs IN the TUI process
 * (embedded kap-server over the harness's injected engine scope + an outbound
 * hub tunnel) — the TUI never stops for it.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { RunningServer } from '@moonshot-ai/kap-server';
import type { TunnelClientHandle, TunnelClientState } from '@moonshot-ai/remote-tunnel/agent';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleRemoteCommand, notifyRemoteSessionChanged } from '#/tui/commands/remote';

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(),
  startTunnelClient: vi.fn(),
}));

vi.mock('@moonshot-ai/kap-server', () => ({ startServer: mocks.startServer }));
vi.mock('@moonshot-ai/remote-tunnel/agent', () => ({
  startTunnelClient: mocks.startTunnelClient,
}));

interface FakeConnection {
  server: RunningServer & { close: ReturnType<typeof vi.fn> };
  tunnel: TunnelClientHandle & {
    close: ReturnType<typeof vi.fn>;
    updateScope: ReturnType<typeof vi.fn>;
  };
  onState: (state: TunnelClientState) => void;
}

/**
 * One duck-typed accessor object every engine-service probe lands on. The
 * surfaces the connect path reaches: `IEventService.subscribe` (notify
 * bridge), `ISessionManager.get` (the turn-notify bridge's live session
 * lookup — returns undefined here, cold sessions contribute no taps),
 * `IHubConnectionService.configure` (the gated hub tools).
 * Matching by member shape - rather than decorator identity - survives the
 * inner describe's `vi.resetModules()` (fresh module instances re-create
 * every decorator's identity).
 */
function makeEngineStub(): {
  subscribe: () => { dispose: () => void };
  get: () => undefined;
  configure: ReturnType<typeof vi.fn>;
} {
  return {
    subscribe: () => ({ dispose: () => undefined }),
    get: () => undefined,
    configure: vi.fn(),
  };
}

function makeHost(engineScope: unknown = {}, sessionId = 'ses-1'): SlashCommandHost & {
  showStatus: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  showNotice: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setExitForegroundTask: ReturnType<typeof vi.fn>;
  engine: { configure: ReturnType<typeof vi.fn> };
} {
  const engine = makeEngineStub();
  if (typeof engineScope === 'object' && engineScope !== null && !('accessor' in engineScope)) {
    (engineScope as Record<string, unknown>)['accessor'] = { get: () => engine };
  }
  return {
    session: { id: sessionId },
    harness: { engineScope, homeDir: '/tmp/kimi-home' },
    state: { appState: { version: '1.2.3' } },
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    stop: vi.fn(async () => {}),
    setExitForegroundTask: vi.fn(),
    engine,
  } as unknown as ReturnType<typeof makeHost>;
}

describe('remote slash command', () => {
  let lastServer: FakeConnection['server'] | undefined;
  let lastConn: FakeConnection | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    lastServer = undefined;
    lastConn = undefined;
    mocks.startServer.mockImplementation(async () => {
      lastServer = {
        host: '127.0.0.1',
        port: 59999,
        close: vi.fn(async () => {}),
      } as unknown as FakeConnection['server'];
      return lastServer;
    });
    mocks.startTunnelClient.mockImplementation(
      (opts: { onState: (state: TunnelClientState) => void }) => {
        const tunnel = {
          close: vi.fn(async () => {}),
          agentId: vi.fn(() => 'agent-1'),
          updateScope: vi.fn(),
        } as unknown as FakeConnection['tunnel'];
        lastConn = { server: lastServer!, tunnel, onState: opts.onState };
        return tunnel;
      },
    );
  });

  afterEach(async () => {
    // Reset the command module's single-connection holder via the public surface.
    await handleRemoteCommand(makeHost(), 'disconnect');
  });

  async function connect(
    host: SlashCommandHost,
    args = 'connect https://hub.example.com --token t-1',
  ) {
    await handleRemoteCommand(host, args);
  }

  it('starts an in-process server over the injected engine scope and dials the tunnel — without stopping the TUI', async () => {
    const host = makeHost();
    await connect(host);

    expect(mocks.startServer).toHaveBeenCalledOnce();
    const serverOpts = mocks.startServer.mock.calls[0]![0] as Record<string, unknown>;
    expect(serverOpts['core']).toBe(host.harness.engineScope);
    expect(serverOpts['homeDir']).toBe('/tmp/kimi-home');
    expect(serverOpts['host']).toBe('127.0.0.1');
    expect(serverOpts['logLevel']).toBe('silent');
    expect(serverOpts['insecureNoTls']).toBe(true);

    expect(mocks.startTunnelClient).toHaveBeenCalledOnce();
    const tunnelOpts = mocks.startTunnelClient.mock.calls[0]![0] as {
      hubUrl: string;
      token: string;
      agent: { name: string; scope: { sessions: string[] } };
      local: { httpBase: string };
    };
    expect(tunnelOpts.hubUrl).toBe('https://hub.example.com');
    expect(tunnelOpts.token).toBe('t-1');
    // Scoped to the CURRENT session — the hub can never reach anything else.
    expect(tunnelOpts.agent.scope.sessions).toEqual(['ses-1']);
    // The tunnel serves the BOUND port (the port walk may shift it).
    expect(tunnelOpts.local.httpBase).toBe('http://127.0.0.1:59999');

    // No handoff: the TUI keeps running.
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.setExitForegroundTask).not.toHaveBeenCalled();
  });

  it('survives state frames emitted synchronously by the tunnel client', async () => {
    // Regression: `startTunnelClient` fires its initial `connecting` state
    // synchronously from the constructor — before the handler's `conn` record
    // existed, that frame crashed connect() (`conn.tunnelState` on undefined).
    mocks.startTunnelClient.mockImplementationOnce(
      (opts: { onState: (state: TunnelClientState) => void }) => {
        opts.onState({ kind: 'connecting' });
        const tunnel = {
          close: vi.fn(async () => {}),
          agentId: vi.fn(() => 'agent-1'),
        } as unknown as FakeConnection['tunnel'];
        lastConn = { server: lastServer!, tunnel, onState: opts.onState };
        return tunnel;
      },
    );
    const host = makeHost();
    await connect(host);
    expect(host.showError).not.toHaveBeenCalled();
    // Later frames route through the registered connection as usual.
    lastConn!.onState({ kind: 'connected', agentId: 'agent-1' });
    expect(host.showNotice).toHaveBeenCalled();
  });

  it('shows an error and starts nothing when the engine scope is unavailable (legacy engine)', async () => {
    const host = makeHost();
    (host.harness as { engineScope: unknown }).engineScope = undefined;
    await connect(host);

    expect(host.showNotice).not.toHaveBeenCalled();
    expect(String(host.showError.mock.calls[0]![0])).toContain('v2 engine');
    expect(mocks.startServer).not.toHaveBeenCalled();
    expect(mocks.startTunnelClient).not.toHaveBeenCalled();
  });

  it('shows an error without a session', async () => {
    const host = makeHost();
    host.session = undefined;
    await connect(host);

    expect(host.showError).toHaveBeenCalledOnce();
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  it('connects tokenless when neither --token nor KIMI_HUB_TOKEN is set (bypass-mode hubs)', async () => {
    const saved = process.env['KIMI_HUB_TOKEN'];
    delete process.env['KIMI_HUB_TOKEN'];
    try {
      const host = makeHost();
      await handleRemoteCommand(host, 'connect https://hub.example.com');

      expect(host.showError).not.toHaveBeenCalled();
      expect(mocks.startTunnelClient).toHaveBeenCalledOnce();
      const opts = mocks.startTunnelClient.mock.calls[0]![0] as { token: string };
      expect(opts.token).toBe('');
    } finally {
      if (saved === undefined) delete process.env['KIMI_HUB_TOKEN'];
      else process.env['KIMI_HUB_TOKEN'] = saved;
    }
  });

  it('rejects a second connect while connected, pointing at /remote disconnect', async () => {
    const host = makeHost();
    await connect(host);
    await connect(host, 'connect https://other.example.com --token t-2');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('/remote disconnect'));
    expect(mocks.startServer).toHaveBeenCalledOnce();
  });

  it('reports a successful connection and closes tunnel + server on disconnect', async () => {
    const host = makeHost();
    await connect(host);
    lastConn!.onState({ kind: 'connected', agentId: 'agent-1' });

    expect(String(host.showNotice.mock.calls[0]![0])).toBe('Remote control connected');

    await handleRemoteCommand(host, 'disconnect');

    expect(lastConn!.tunnel.close).toHaveBeenCalledOnce();
    expect(lastServer!.close).toHaveBeenCalledOnce();
    expect(host.showStatus).toHaveBeenCalledWith('Remote control disconnected.');
  });

  it('publishes the hub connection for the gated tools, and clears it on disconnect', async () => {
    const host = makeHost();
    await connect(host);
    expect(host.engine.configure).toHaveBeenLastCalledWith({
      hubUrl: 'https://hub.example.com',
      token: 't-1',
      agentName: expect.any(String),
      agentId: expect.any(Function),
      sessionIds: ['ses-1'],
    });

    await handleRemoteCommand(host, 'disconnect');
    expect(host.engine.configure).toHaveBeenLastCalledWith(undefined);
  });

  it('republishes the session set when the scope union widens on a live connection', async () => {
    const host = makeHost();
    await connect(host);

    notifyRemoteSessionChanged('ses-2');

    expect(host.engine.configure).toHaveBeenLastCalledWith({
      hubUrl: 'https://hub.example.com',
      token: 't-1',
      agentName: expect.any(String),
      agentId: expect.any(Function),
      sessionIds: ['ses-1', 'ses-2'],
    });
  });

  it('auto-cleans the tunnel + server when the hub rejects the connection', async () => {
    const host = makeHost();
    await connect(host);
    lastConn!.onState({ kind: 'rejected', reason: 'unauthorized' });

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
    await vi.waitFor(() => {
      expect(lastConn!.tunnel.close).toHaveBeenCalled();
      expect(lastServer!.close).toHaveBeenCalled();
    });

    // The holder was dropped: a bare status query reports the idle state.
    host.showStatus.mockClear();
    await handleRemoteCommand(host, '');
    expect(host.showStatus).toHaveBeenCalledWith('Remote control is not connected.');
  });

  it('reports connection state for status (and bare /remote)', async () => {
    const host = makeHost();
    await handleRemoteCommand(host, 'status');
    expect(host.showStatus).toHaveBeenCalledWith('Remote control is not connected.');

    await connect(host);
    host.showNotice.mockClear();
    await handleRemoteCommand(host, '');

    expect(host.showNotice).toHaveBeenCalledOnce();
    const detail = String(host.showNotice.mock.calls[0]![1]);
    expect(detail).toContain('https://hub.example.com');
    expect(detail).toContain('ses-1');
  });

  it('shows the parse error for malformed arguments', async () => {
    const host = makeHost();
    await handleRemoteCommand(host, 'connect --bogus');

    expect(host.showError).toHaveBeenCalledOnce();
    expect(String(host.showError.mock.calls[0]![0])).toContain('usage:');
    expect(mocks.startServer).not.toHaveBeenCalled();
  });

  /**
   * Per-process scope UNION: `notifyRemoteSessionChanged` only ever grows the
   * module-level set, so its tests need isolated module state — hence
   * `vi.resetModules()` + a fresh dynamic import per test. The hoisted
   * `vi.mock` factories re-run against the same spies for the new instance.
   */
  describe('scope union bookkeeping', () => {
    let remote: typeof import('#/tui/commands/remote');

    beforeEach(async () => {
      vi.resetModules();
      remote = await import('#/tui/commands/remote');
    });

    afterEach(async () => {
      // Drop this module instance's connection holder via its own surface.
      await remote.handleRemoteCommand(makeHost(), 'disconnect');
    });

    const connect = (host: SlashCommandHost): Promise<void> =>
      remote.handleRemoteCommand(host, 'connect https://hub.example.com --token t-1');

    const lastHelloScope = (): string[] => {
      const opts = mocks.startTunnelClient.mock.calls.at(-1)![0] as {
        agent: { scope: { sessions: string[] } };
      };
      return opts.agent.scope.sessions;
    };

    it('(a) connect seeds the union with the current session', async () => {
      const host = makeHost();
      await connect(host);
      expect(lastHelloScope()).toEqual(['ses-1']);
    });

    it('(b) notify on a live connection emits the full union', async () => {
      const host = makeHost();
      await connect(host);
      lastConn!.onState({ kind: 'connected', agentId: 'agent-1' });

      remote.notifyRemoteSessionChanged('ses-2');

      expect(lastConn!.tunnel.updateScope).toHaveBeenCalledTimes(1);
      expect(lastConn!.tunnel.updateScope).toHaveBeenCalledWith(['ses-1', 'ses-2']);
    });

    it('(c) a duplicate (or empty) notify is a strict no-op', async () => {
      const host = makeHost();
      await connect(host);
      lastConn!.onState({ kind: 'connected', agentId: 'agent-1' });

      remote.notifyRemoteSessionChanged('ses-1'); // connect-time session, already tracked
      remote.notifyRemoteSessionChanged('');

      expect(lastConn!.tunnel.updateScope).not.toHaveBeenCalled();
    });

    it('(d) the union survives disconnect + connect with a new current session', async () => {
      const host = makeHost();
      await connect(host);
      await remote.handleRemoteCommand(host, 'disconnect');

      await connect(makeHost({}, 'ses-2'));

      expect(mocks.startTunnelClient).toHaveBeenCalledTimes(2);
      expect(lastHelloScope()).toEqual(['ses-1', 'ses-2']);
    });

    it('(e) a notify with no connection buffers silently into the next hello', async () => {
      remote.notifyRemoteSessionChanged('ses-early');
      expect(mocks.startTunnelClient).not.toHaveBeenCalled(); // nothing to emit to

      await connect(makeHost());

      expect(lastHelloScope()).toEqual(['ses-early', 'ses-1']);
    });
  });
});
