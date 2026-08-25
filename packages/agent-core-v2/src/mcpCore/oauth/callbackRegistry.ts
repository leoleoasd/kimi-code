import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface McpOAuthExternalCallback {
  readonly code?: string;
  readonly error?: string;
}

export interface McpOAuthCallbackFlow {
  readonly serverName: string;
  deliver(result: McpOAuthExternalCallback): void;
}

export interface IMcpOAuthCallbackRegistry {
  readonly _serviceBrand: undefined;
  begin(state: string, flow: McpOAuthCallbackFlow): () => void;
  deliver(state: string, result: McpOAuthExternalCallback): boolean;
}

export const IMcpOAuthCallbackRegistry: ServiceIdentifier<IMcpOAuthCallbackRegistry> =
  createDecorator<IMcpOAuthCallbackRegistry>('mcpOAuthCallbackRegistry');
