import { describe, expect, it } from 'vitest';

import {
  parseShellInput,
  parseShellOutput,
  shellCommandInfo,
} from './shellCommand';

describe('shellCommandInfo', () => {
  it('detects input and output record origins', () => {
    expect(shellCommandInfo({ kind: 'shell_command', phase: 'input' })).toEqual({
      phase: 'input',
      isError: false,
    });
    expect(
      shellCommandInfo({ kind: 'shell_command', phase: 'output', isError: true }),
    ).toEqual({ phase: 'output', isError: true });
  });

  it('ignores non-shell origins and absent payloads', () => {
    expect(shellCommandInfo(undefined)).toBeUndefined();
    expect(shellCommandInfo(null)).toBeUndefined();
    expect(shellCommandInfo({ kind: 'injection', variant: 'user' })).toBeUndefined();
    expect(shellCommandInfo({ kind: 'shell_command' })).toBeUndefined();
  });
});

describe('parseShellInput', () => {
  it('unwraps the bash-input tag and unescapes the payload', () => {
    expect(
      parseShellInput('<bash-input>\ncurl -d &quot;{&lt;x&gt;: 1 &amp;&amp; 2}&quot;\n</bash-input>'),
    ).toBe('curl -d "{<x>: 1 && 2}"');
  });

  it('falls back to the raw text when the tag is missing', () => {
    expect(parseShellInput('echo raw')).toBe('echo raw');
  });
});

describe('parseShellOutput', () => {
  it('unwraps stdout and stderr', () => {
    const { stdout, stderr } = parseShellOutput(
      '<bash-stdout>hello &lt;world&gt;</bash-stdout><bash-stderr>oops &amp; more</bash-stderr>',
    );
    expect(stdout).toBe('hello <world>');
    expect(stderr).toBe('oops & more');
  });

  it('returns empty streams when the tags are missing', () => {
    expect(parseShellOutput('plain')).toEqual({ stdout: '', stderr: '' });
  });
});
