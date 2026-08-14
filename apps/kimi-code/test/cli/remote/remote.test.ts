/**
 * Tests for `kimi remote connect` / `/remote connect`: the Commander wiring
 * and the shared hub URL / hub token / argument parsers. The foreground
 * server and the hub tunnel are never started here.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { type HubConnection, IHubConnectionService, type Scope } from '@moonshot-ai/agent-core-v2';

import { registerRemoteCommand } from '#/cli/sub/remote';
import { DEFAULT_LOCAL_HUB_URL, hubUiUrl, parseHubUrl, parseRemoteCommand, resolveHubToken, wireHubTools } from '#/cli/sub/remote/shared';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerRemoteCommand(program);
  return program;
}

describe('kimi remote', () => {
  it('registers the `remote` command with only the `connect` subcommand', () => {
    const program = makeProgram();
    const remote = program.commands.find((c) => c.name() === 'remote');
    expect(remote).toBeDefined();
    expect(remote?.commands.map((c) => c.name())).toEqual(['connect']);
  });

  it('exposes the hub options and the <hub-url> argument on `remote connect`', () => {
    const program = makeProgram();
    const connect = program.commands
      .find((c) => c.name() === 'remote')
      ?.commands.find((c) => c.name() === 'connect');
    expect(connect).toBeDefined();
    const longs = connect!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--token');
    expect(longs).toContain('--name');
    expect(longs).toContain('--port');
    expect(longs).toContain('--session');
    // The TUI `/remote` handoff takes the same token flag.
    const argNames = connect!.registeredArguments.map((a) => a.name());
    expect(argNames).toEqual(['hub-url']);
  });

  it('requires --session (every connection is scoped to one session)', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync([
        'node',
        'kimi',
        'remote',
        'connect',
        'https://hub.example.com',
        '--token',
        't',
      ]),
    ).rejects.toThrow(/required option '--session <id>' not specified/);
  });

  it('marks --session as a mandatory commander option', () => {
    const program = makeProgram();
    const connect = program.commands
      .find((c) => c.name() === 'remote')
      ?.commands.find((c) => c.name() === 'connect');
    const session = connect!.options.find((o) => o.long === '--session');
    expect(session).toMatchObject({ long: '--session', required: true });
  });
});

describe('parseHubUrl', () => {
  it('accepts http(s):// and ws(s):// origins', () => {
    expect(parseHubUrl('http://hub.example.com')).toBe('http://hub.example.com');
    expect(parseHubUrl('https://hub.example.com:8443/')).toBe('https://hub.example.com:8443/');
    expect(parseHubUrl('ws://127.0.0.1:9000')).toBe('ws://127.0.0.1:9000');
    expect(parseHubUrl('wss://hub.example.com/path')).toBe('wss://hub.example.com/path');
  });

  it('trims surrounding whitespace', () => {
    expect(parseHubUrl('  https://hub.example.com  ')).toBe('https://hub.example.com');
  });

  it('rejects other schemes and scheme-less hosts with a clear error', () => {
    for (const raw of ['hub.example.com', 'ftp://hub.example.com', 'tcp://hub:1', '']) {
      expect(() => parseHubUrl(raw)).toThrow(/invalid hub URL/);
      expect(() => parseHubUrl(raw)).toThrow(/http\(s\):\/\/ or ws\(s\):\/\//);
    }
  });
});

describe('hubUiUrl', () => {
  it('maps ws(s):// hub URLs back to http(s):// and leaves http(s) untouched', () => {
    expect(hubUiUrl('ws://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(hubUiUrl('wss://hub.example.com/path')).toBe('https://hub.example.com/path');
    expect(hubUiUrl('https://hub.example.com:8443')).toBe('https://hub.example.com:8443');
  });
});

describe('resolveHubToken', () => {
  it('prefers the --token flag over the env var', () => {
    expect(resolveHubToken('flag-token', { KIMI_HUB_TOKEN: 'env-token' })).toBe('flag-token');
  });

  it('falls back to KIMI_HUB_TOKEN when no flag is passed', () => {
    expect(resolveHubToken(undefined, { KIMI_HUB_TOKEN: 'env-token' })).toBe('env-token');
  });

  it('treats an empty flag as absent and uses the env var', () => {
    expect(resolveHubToken('', { KIMI_HUB_TOKEN: 'env-token' })).toBe('env-token');
  });

  it('returns undefined when neither flag nor env provides a token (bypass-mode hubs are tokenless)', () => {
    expect(resolveHubToken(undefined, {})).toBeUndefined();
  });

  it('rejects a whitespace-only env token as absent', () => {
    expect(resolveHubToken(undefined, { KIMI_HUB_TOKEN: '   ' })).toBeUndefined();
  });
});

describe('parseRemoteCommand (/remote)', () => {
  it('parses `connect <hub-url>` with no flags', () => {
    expect(parseRemoteCommand('connect https://hub.example.com')).toEqual({
      kind: 'connect',
      hubUrl: 'https://hub.example.com',
      token: undefined,
      name: undefined,
    });
  });

  it('an omitted hub URL defaults to the local hub', () => {
    expect(parseRemoteCommand('connect')).toEqual({
      kind: 'connect',
      hubUrl: DEFAULT_LOCAL_HUB_URL,
      token: undefined,
      name: undefined,
    });
    expect(parseRemoteCommand('connect --token t-1')).toEqual({
      kind: 'connect',
      hubUrl: DEFAULT_LOCAL_HUB_URL,
      token: 't-1',
      name: undefined,
    });
  });

  it('parses --token and --name values, both separated and =-joined', () => {
    expect(parseRemoteCommand('connect https://hub.example.com --token t-1 --name dev-box')).toEqual(
      {
        kind: 'connect',
        hubUrl: 'https://hub.example.com',
        token: 't-1',
        name: 'dev-box',
      },
    );
    expect(parseRemoteCommand('connect ws://hub:1 --token=t-2')).toEqual({
      kind: 'connect',
      hubUrl: 'ws://hub:1',
      token: 't-2',
      name: undefined,
    });
  });

  it('accepts flags before the hub URL (first non-flag token is the URL)', () => {
    expect(parseRemoteCommand('connect --token t https://hub.example.com')).toEqual({
      kind: 'connect',
      hubUrl: 'https://hub.example.com',
      token: 't',
      name: undefined,
    });
  });

  it('adopts the #token= fragment from a pasted banner link, --token wins', () => {
    expect(parseRemoteCommand('connect http://127.0.0.1:58630#token=frag-1')).toEqual({
      kind: 'connect',
      hubUrl: 'http://127.0.0.1:58630',
      token: 'frag-1',
      name: undefined,
    });
    expect(parseRemoteCommand('connect http://host:1/#token=frag-2 --token flag-1')).toEqual({
      kind: 'connect',
      hubUrl: 'http://host:1/',
      token: 'flag-1',
      name: undefined,
    });
  });

  it('parses `disconnect` and `status`, with bare `/remote` meaning status', () => {
    expect(parseRemoteCommand('disconnect')).toEqual({ kind: 'disconnect' });
    expect(parseRemoteCommand('status')).toEqual({ kind: 'status' });
    expect(parseRemoteCommand('')).toEqual({ kind: 'status' });
    expect(parseRemoteCommand('   ')).toEqual({ kind: 'status' });
  });

  it('rejects extra arguments on `disconnect` and `status`', () => {
    for (const args of ['disconnect now', 'status full']) {
      const parsed = parseRemoteCommand(args);
      expect(parsed.kind).toBe('error');
      if (parsed.kind === 'error') {
        expect(parsed.message).toContain('/remote connect');
      }
    }
  });

  it('errors with usage when the subcommand is missing', () => {
    const parsed = parseRemoteCommand('https://hub.example.com');
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.message).toContain('/remote connect');
    }
  });

  it('rejects unknown subcommands, unknown flags, dangling flags, and extra positionals', () => {
    const unknownSub = parseRemoteCommand('pause');
    expect(unknownSub.kind).toBe('error');
    if (unknownSub.kind === 'error') expect(unknownSub.message).toContain('usage:');

    const unknown = parseRemoteCommand('connect https://hub.example.com --verbose');
    expect(unknown.kind).toBe('error');
    if (unknown.kind === 'error') expect(unknown.message).toContain('unknown flag: --verbose');

    const dangling = parseRemoteCommand('connect https://hub.example.com --token');
    expect(dangling.kind).toBe('error');
    if (dangling.kind === 'error') expect(dangling.message).toContain('--token requires a value');

    const extra = parseRemoteCommand('connect a.example.com b.example.com');
    expect(extra.kind).toBe('error');
    if (extra.kind === 'error') expect(extra.message).toContain('unexpected argument');
  });

  it('has no --session flag — the TUI auto-scopes to the current session', () => {
    const parsed = parseRemoteCommand('connect https://hub.example.com --session s-1');
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') expect(parsed.message).toContain('unknown flag: --session');
  });
});

describe('/remote registration', () => {
  it('is registered as an idle-only built-in with a connect hint', () => {
    const command = findBuiltInSlashCommand('remote');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('idle-only');
    expect(command).toMatchObject({
      argumentHint: 'connect <hub-url> [--token <t>] | disconnect | status',
    });
  });
});

describe('wireHubTools', () => {
  function makeCore(): { core: Scope; connection: () => HubConnection | undefined } {
    let current: HubConnection | undefined;
    const core = {
      accessor: {
        get: (id: unknown): unknown =>
          id === IHubConnectionService
            ? {
                configure: (connection: HubConnection | undefined) => {
                  current = connection;
                },
                connection: () => current,
              }
            : undefined,
      },
    } as unknown as Scope;
    return { core, connection: () => current };
  }

  it('publishes the connection with the initially bridged session ids', () => {
    const { core, connection } = makeCore();
    wireHubTools(core, { hubUrl: 'https://hub.example.com', token: 't-1', agentName: 'dev-box' }, [
      'ses-1',
    ]);
    expect(connection()).toEqual({
      hubUrl: 'https://hub.example.com',
      token: 't-1',
      agentName: 'dev-box',
      sessionIds: ['ses-1'],
    });
  });

  it('widens the published set per attach and ignores repeats', () => {
    const { core, connection } = makeCore();
    const wiring = wireHubTools(core, { hubUrl: 'https://hub.example.com', token: 't-1' }, ['ses-1']);
    wiring.attachSession('ses-2');
    expect(connection()!.sessionIds).toEqual(['ses-1', 'ses-2']);
    wiring.attachSession('ses-2');
    wiring.attachSession('');
    expect(connection()!.sessionIds).toEqual(['ses-1', 'ses-2']);
  });

  it('clears the connection on dispose', () => {
    const { core, connection } = makeCore();
    wireHubTools(core, { hubUrl: 'https://hub.example.com', token: 't-1' }, ['ses-1']).dispose();
    expect(connection()).toBeUndefined();
  });
});
