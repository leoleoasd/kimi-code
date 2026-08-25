import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import {
  IMcpOAuthCallbackRegistry,
  type McpOAuthCallbackFlow,
  type McpOAuthExternalCallback,
} from './callbackRegistry';

export class McpOAuthCallbackRegistryService implements IMcpOAuthCallbackRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly flows = new Map<string, McpOAuthCallbackFlow>();

  begin(state: string, flow: McpOAuthCallbackFlow): () => void {
    this.flows.set(state, flow);
    return () => {
      if (this.flows.get(state) === flow) {
        this.flows.delete(state);
      }
    };
  }

  deliver(state: string, result: McpOAuthExternalCallback): boolean {
    const flow = this.flows.get(state);
    if (flow === undefined) return false;
    flow.deliver(result);
    return true;
  }
}

registerScopedService(
  LifecycleScope.App,
  IMcpOAuthCallbackRegistry,
  McpOAuthCallbackRegistryService,
  ScopeActivation.OnDemand,
  'mcp',
);
