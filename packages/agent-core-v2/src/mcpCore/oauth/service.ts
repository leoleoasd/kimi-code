import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import { ErrorCodes, Error2, isError2 } from '#/errors';

import { startCallbackServer, type CallbackServer } from './callback-server';
import type { IMcpOAuthCallbackRegistry } from './callbackRegistry';
import { McpOAuthClientProvider } from './provider';
import { mcpOAuthStoreKey, type McpOAuthStore } from './store';

export interface McpOAuthServiceOptions {
  readonly store: McpOAuthStore;
  readonly clientLabel?: string;
  readonly resolveClientName?: () => string | undefined;
  readonly callbackRegistry?: IMcpOAuthCallbackRegistry;
}

export interface BeginAuthorizationOptions {
  readonly clientLabel?: string;
  readonly externalRedirectUri?: string;
}

export interface BeginAuthorizationResult {
  readonly authorizationUrl: URL;
  complete(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  cancel(): Promise<void>;
}

export class McpOAuthService {
  private readonly store: McpOAuthStore;
  private readonly clientLabel: string | undefined;
  private readonly resolveClientName: (() => string | undefined) | undefined;
  private readonly callbackRegistry: IMcpOAuthCallbackRegistry | undefined;
  private readonly providers = new Map<string, McpOAuthClientProvider>();

  constructor(options: McpOAuthServiceOptions) {
    this.store = options.store;
    this.clientLabel = options.clientLabel;
    this.resolveClientName = options.resolveClientName;
    this.callbackRegistry = options.callbackRegistry;
  }

  getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider {
    const storeKey = mcpOAuthStoreKey(serverName, serverUrl);
    let provider = this.providers.get(storeKey);
    if (provider === undefined) {
      provider = new McpOAuthClientProvider({
        serverName,
        serverUrl,
        store: this.store,
        clientLabel: this.clientLabel,
        clientName: this.resolveClientName?.(),
      });
      this.providers.set(provider.storeKey, provider);
    }
    return provider;
  }

  async hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean> {
    return (await this.getProvider(serverName, serverUrl).tokens()) !== undefined;
  }

  async beginAuthorization(
    serverName: string,
    serverUrl: string | URL,
    options: BeginAuthorizationOptions = {},
  ): Promise<BeginAuthorizationResult> {
    const provider = options.clientLabel === undefined
      ? this.getProvider(serverName, serverUrl)
      : new McpOAuthClientProvider({
          serverName,
          serverUrl,
          store: this.store,
          clientLabel: options.clientLabel,
          clientName: this.resolveClientName?.(),
        });
    if (options.clientLabel !== undefined) {
      this.providers.set(provider.storeKey, provider);
    }

    provider.resetFlow();

    let callbackServer: CallbackServer;
    try {
      callbackServer = await startCallbackServer();
    } catch (error) {
      throw wrapAuthError('failed to start OAuth callback listener', error);
    }

    const redirectUri = options.externalRedirectUri ?? callbackServer.redirectUri;
    provider.setRedirectUrl(new URL(redirectUri));
    await provider.ready;
    await provider.invalidateStaleRegistration(redirectUri);

    let authorizationUrl: URL | undefined;
    try {
      const result = await auth(provider as OAuthClientProvider, { serverUrl });
      if (result !== 'REDIRECT') {
        await callbackServer.close();
        throw new AlreadyAuthorizedError(serverName);
      }
      authorizationUrl = provider.takeAuthorizationUrl();
      if (authorizationUrl === undefined) {
        throw new Error2(
          ErrorCodes.MCP_OAUTH_FAILED,
          'OAuth provider did not capture an authorization URL',
        );
      }
    } catch (error) {
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
      if (error instanceof AlreadyAuthorizedError) throw error;
      throw wrapAuthError(`failed to start OAuth flow for "${serverName}"`, error);
    }

    let unregisterCallback: (() => void) | undefined;
    if (options.externalRedirectUri !== undefined && this.callbackRegistry !== undefined) {
      const state = provider.expectedState();
      if (state !== undefined) {
        unregisterCallback = this.callbackRegistry.begin(state, {
          serverName,
          deliver: (result) => {
            if (result.code !== undefined && result.code !== '') {
              callbackServer.deliver({ code: result.code, state });
              return;
            }
            callbackServer.deliverError(
              new Error(`OAuth provider reported an error: ${result.error ?? 'unknown'}`),
            );
          },
        });
      }
    }

    let settled = false;
    const cancel = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      unregisterCallback?.();
      unregisterCallback = undefined;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    const complete: BeginAuthorizationResult['complete'] = async (opts = {}) => {
      if (settled) {
        throw new Error2(ErrorCodes.MCP_OAUTH_FAILED, 'OAuth flow already completed or cancelled');
      }
      try {
        const { code, state } = await callbackServer.waitForCode({
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        const expectedState = provider.expectedState();
        if (expectedState !== undefined && state !== expectedState) {
          throw new Error2(
            ErrorCodes.MCP_OAUTH_FAILED,
            'OAuth state mismatch — possible CSRF; refusing token exchange',
          );
        }
        const finalResult = await auth(provider as OAuthClientProvider, {
          serverUrl,
          authorizationCode: code,
        });
        if (finalResult !== 'AUTHORIZED') {
          throw new Error2(
            ErrorCodes.MCP_OAUTH_FAILED,
            `OAuth code exchange returned "${finalResult}" instead of AUTHORIZED`,
            { details: { result: finalResult } },
          );
        }
      } catch (error) {
        await cancel();
        throw wrapAuthError(`OAuth flow for "${serverName}" failed`, error);
      }
      settled = true;
      unregisterCallback?.();
      unregisterCallback = undefined;
      await callbackServer.close().catch(() => undefined);
      provider.resetFlow();
    };

    return { authorizationUrl, complete, cancel };
  }

  invalidate(
    serverName: string,
    serverUrl: string | URL,
    scope: 'all' | 'client' | 'tokens' | 'discovery' = 'all',
  ): Promise<void> {
    return this.getProvider(serverName, serverUrl).invalidateCredentials(scope);
  }
}

export class AlreadyAuthorizedError extends Error2 {
  constructor(serverName: string) {
    super(
      ErrorCodes.MCP_OAUTH_FAILED,
      `"${serverName}" is already authorized; no browser flow needed`,
    );
    this.name = 'AlreadyAuthorizedError';
  }
}

function wrapAuthError(prefix: string, error: unknown): Error2 {
  if (isError2(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new Error2(ErrorCodes.MCP_OAUTH_FAILED, `${prefix}: ${error.message}`, {
      cause: error,
    });
  }
  return new Error2(ErrorCodes.MCP_OAUTH_FAILED, `${prefix}: ${String(error)}`, { cause: error });
}
