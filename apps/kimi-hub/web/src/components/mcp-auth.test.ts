import { describe, expect, it } from 'vitest';

import type { ToolCallFrame } from '@moonshot-ai/transcript';

import { resolveMcpAuthDisplay } from './mcp-auth';

function frame(overrides: Partial<ToolCallFrame>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: 'f1',
    toolCallId: 'call-1',
    name: 'mcp__notion__authenticate',
    state: 'running',
    ...overrides,
  };
}

const URL = 'https://mcp.notion.com/authorize?client_id=abc&state=xyz';

describe('resolveMcpAuthDisplay', () => {
  it('ignores non-authenticate tools', () => {
    expect(resolveMcpAuthDisplay(frame({ name: 'Bash' }))).toBeUndefined();
    expect(resolveMcpAuthDisplay(frame({ name: 'mcp__notion__notion-fetch' }))).toBeUndefined();
  });

  it('reads the custom authorization_url progress payload first', () => {
    const display = resolveMcpAuthDisplay(
      frame({
        progress: {
          kind: 'custom',
          customKind: 'mcp.oauth.authorization_url',
          customData: { serverName: 'notion', authorizationUrl: URL },
        },
      }),
    );
    expect(display?.serverName).toBe('notion');
    expect(display?.authorizationUrl).toBe(URL);
  });

  it('falls back to the URL inside the status text', () => {
    const display = resolveMcpAuthDisplay(
      frame({
        progress: {
          kind: 'status',
          text: `Open this URL in your browser to authorize "notion":\n\n${URL}\n\nWaiting…`,
        },
      }),
    );
    expect(display?.serverName).toBe('notion');
    expect(display?.authorizationUrl).toBe(URL);
    expect(display?.statusText).toContain('Open this URL');
    expect(display?.statusText).not.toContain(URL);
    expect(display?.statusText).toContain('Waiting…');
  });

  it('recovers the URL from the error output when the flow timed out', () => {
    const display = resolveMcpAuthDisplay(
      frame({
        state: 'error',
        output: `OAuth flow for MCP server "notion" did not complete: timed out\n\nAuthorization URL (still valid if the listener has not timed out): ${URL}`,
      }),
    );
    expect(display?.authorizationUrl).toBe(URL);
  });

  it('tolerates a frame with no URL anywhere', () => {
    const display = resolveMcpAuthDisplay(frame({}));
    expect(display?.serverName).toBe('notion');
    expect(display?.authorizationUrl).toBeUndefined();
  });
});
