import { IMcpOAuthCallbackRegistry, type Scope } from '@moonshot-ai/agent-core-v2';

interface McpOAuthReply {
  code(statusCode: number): McpOAuthReply;
  type(contentType: string): McpOAuthReply;
  send(payload: string): unknown;
}

interface McpOAuthRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string; query: unknown }, reply: McpOAuthReply) => unknown,
  ): unknown;
}

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in complete</h1>' +
  '<p>You can close this tab and return to the application.</p>' +
  '</body></html>';

const ERROR_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>OAuth error</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>Sign-in failed</h1>' +
  '<p>The authorization server reported an error. Return to the application for details.</p>' +
  '</body></html>';

const UNKNOWN_FLOW_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>OAuth flow unknown</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem;">' +
  '<h1>No pending sign-in</h1>' +
  '<p>This OAuth flow is unknown or already expired. Start it again from the application.</p>' +
  '</body></html>';

export function registerMcpOAuthRoutes(app: McpOAuthRouteHost, core: Scope): void {
  app.get(
    '/mcp/oauth/callback',
    { schema: { hide: true } },
    (req: { id: string; query: unknown }, reply: McpOAuthReply) => {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const state = typeof query['state'] === 'string' && query['state'] !== '' ? query['state'] : undefined;
      const code = typeof query['code'] === 'string' && query['code'] !== '' ? query['code'] : undefined;
      const error = typeof query['error'] === 'string' && query['error'] !== '' ? query['error'] : undefined;
      if (state === undefined || (code === undefined && error === undefined)) {
        return reply.code(400).type(HTML_CONTENT_TYPE).send(ERROR_HTML);
      }
      const errorDescription =
        typeof query['error_description'] === 'string' ? query['error_description'] : undefined;
      const delivered = core.accessor.get(IMcpOAuthCallbackRegistry).deliver(
        state,
        code !== undefined
          ? { code }
          : {
              error:
                errorDescription !== undefined ? `${error}: ${errorDescription}` : (error as string),
            },
      );
      if (!delivered) {
        return reply.code(404).type(HTML_CONTENT_TYPE).send(UNKNOWN_FLOW_HTML);
      }
      if (error !== undefined) {
        return reply.code(400).type(HTML_CONTENT_TYPE).send(ERROR_HTML);
      }
      return reply.code(200).type(HTML_CONTENT_TYPE).send(SUCCESS_HTML);
    },
  );
}
