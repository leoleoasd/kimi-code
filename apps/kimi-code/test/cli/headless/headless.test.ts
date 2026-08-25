/**
 * Tests for the `kimi headless` Commander wiring: registration shape, hub URL
 * / token / name resolution order (flag > tui.toml [remote] > defaults), the
 * default detached respawn (spawn detached, env marker, log redirect), and the
 * `--foreground` pass-through into `runHeadless`. The foreground server and
 * the hub tunnel are never started here.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerHeadlessCommand } from '#/cli/sub/headless';
import { runHeadless } from '#/cli/sub/headless/run';
import { DEFAULT_LOCAL_HUB_URL } from '#/cli/sub/remote/shared';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: vi.fn(), openSync: vi.fn(() => 3) };
});

vi.mock('#/cli/sub/headless/run', () => ({
  runHeadless: vi.fn(async () => undefined as never),
}));

vi.mock('#/tui/config', () => ({
  loadTuiConfig: vi.fn(async () => ({
    remote: { hubUrl: 'http://hub.test:58630', token: 'cfg-token', name: 'cfg-name' },
  })),
}));

const spawnMock = vi.mocked(spawn);
const runMock = vi.mocked(runHeadless);

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerHeadlessCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<string> {
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  spawnMock.mockReturnValue({ unref: vi.fn(), pid: 4242 } as never);
  try {
    await makeProgram().parseAsync(['node', 'kimi', 'headless', ...args]);
  } finally {
    spy.mockRestore();
  }
  return stdout;
}

describe('kimi headless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['KIMI_HEADLESS_FOREGROUND'];
  });
  afterEach(() => {
    delete process.env['KIMI_HEADLESS_FOREGROUND'];
  });

  it('registers the `headless` command with its options', () => {
    const program = makeProgram();
    const headless = program.commands.find((c) => c.name() === 'headless');
    expect(headless).toBeDefined();
    const flags = headless!.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(['--token', '--name', '--session', '--title', '--port', '--foreground']),
    );
  });

  it('detaches by default: respawns itself with the env marker and prints the log path', async () => {
    const stdout = await runCli([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    // Respawn passes forward a rebuilt `headless` argv (option values only) —
    // never process.argv, whose SEA mapping would re-add the binary path.
    expect(argv).toEqual([...process.execArgv, process.argv[1], 'headless', '--port', '58627']);
    expect((opts as { detached?: boolean }).detached).toBe(true);
    expect((opts as { env?: Record<string, string> }).env?.['KIMI_HEADLESS_FOREGROUND']).toBe('1');
    expect(mkdirSync).toHaveBeenCalled();
    expect(openSync).toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(stdout).toContain('detached as pid 4242');
    expect(stdout).toContain('hub.test:58630');
    expect(stdout).toContain('stop: kill 4242');
  });

  it('never respawns when the env marker is already set', async () => {
    process.env['KIMI_HEADLESS_FOREGROUND'] = '1';
    await runCli([]);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('resolves hub url: positional arg beats tui.toml, which beats the local default', async () => {
    await runCli([]);
    expect(runMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    process.env['KIMI_HEADLESS_FOREGROUND'] = '1';
    await runCli([]);
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ hubUrl: 'http://hub.test:58630' }));

    vi.clearAllMocks();
    process.env['KIMI_HEADLESS_FOREGROUND'] = '1';
    await runCli(['http://example.com:9999']);
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ hubUrl: 'http://example.com:9999' }));
  });

  it('falls back to the local hub when neither flag nor config provides one', async () => {
    const { loadTuiConfig } = await import('#/tui/config');
    vi.mocked(loadTuiConfig).mockResolvedValueOnce({
      remote: { hubUrl: null, token: null, name: null },
    } as never);
    process.env['KIMI_HEADLESS_FOREGROUND'] = '1';
    await runCli([]);
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ hubUrl: DEFAULT_LOCAL_HUB_URL }));
  });

  it('passes --session / --title / --name / --token through to runHeadless', async () => {
    process.env['KIMI_HEADLESS_FOREGROUND'] = '1';
    await runCli([
      '--foreground',
      '--session',
      'session_abc',
      '--title',
      'my session',
      '--name',
      'gpu-box',
      '--token',
      'flag-token',
    ]);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_abc',
        title: 'my session',
        name: 'gpu-box',
        token: 'flag-token',
      }),
    );
  });

  it('inherits name/token defaults from tui.toml [remote] when flags are absent', async () => {
    process.env['KIMI_HEADLESS_FOREGROUND'] = '1';
    await runCli([]);
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cfg-name', token: 'cfg-token', sessionId: undefined, title: undefined }),
    );
  });
});
