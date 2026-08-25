/**
 * `mcp__<server>__authenticate` tool frame → login display model. The engine's
 * synthetic auth tool emits a `mcp.oauth.authorization_url` custom progress
 * payload, then a status text carrying the same URL; the frame's `progress`
 * only keeps the LATEST update, so the URL is recovered from the custom
 * payload first, then from any http(s) URL in the status text, then from the
 * final output (the error output re-prints it). Mirrored on the protocol in
 * `packages/agent-core-v2/src/agent/mcp/tools/auth.ts`.
 */

import type { ToolCallFrame } from '@moonshot-ai/transcript';

const OAUTH_URL_CUSTOM_KIND = 'mcp.oauth.authorization_url';
const HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/;

export interface McpAuthDisplay {
  readonly serverName: string;
  readonly authorizationUrl?: string;
  readonly statusText?: string;
}

function firstUrl(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const match = HTTP_URL_RE.exec(text);
  return match?.[0];
}

export function resolveMcpAuthDisplay(frame: ToolCallFrame): McpAuthDisplay | undefined {
  const match = /^mcp__(.+)__authenticate$/.exec(frame.name);
  if (match === null) return undefined;
  const fallbackName = match[1]!;
  const progress = frame.progress;
  const custom = progress?.customData;
  let serverName = fallbackName;
  let authorizationUrl: string | undefined;
  if (progress?.customKind === OAUTH_URL_CUSTOM_KIND && isRecord(custom)) {
    if (typeof custom['serverName'] === 'string' && custom['serverName'] !== '') {
      serverName = custom['serverName'];
    }
    if (typeof custom['authorizationUrl'] === 'string') {
      authorizationUrl = custom['authorizationUrl'];
    }
  }
  authorizationUrl ??= firstUrl(progress?.text);
  if (authorizationUrl === undefined && typeof frame.output === 'string') {
    authorizationUrl = firstUrl(frame.output);
  }
  let statusText = progress?.text?.trim();
  if (statusText !== undefined && authorizationUrl !== undefined) {
    statusText = statusText.replace(authorizationUrl, '').replace(/\n{3,}/g, '\n\n').trim();
    if (statusText === '') statusText = undefined;
  }
  return {
    serverName,
    authorizationUrl,
    statusText,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
