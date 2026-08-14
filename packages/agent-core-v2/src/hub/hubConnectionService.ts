/**
 * `hub` domain — `IHubConnectionService` implementation.
 *
 * The connection is connector-populated host state held as a plain field —
 * its identity is "the one live hub connection", which is process-wide, so it
 * belongs at App scope. Hub calls go to the hub origin with
 * `Authorization: Bearer <token>` (omitted for bypass-mode hubs whose token
 * is empty). Failures throw plain Errors whose message the calling tool
 * renders straight to the model. Bound at App scope.
 */

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import {
  type HubConnection,
  IHubConnectionService,
  type HubMessageReceipt,
  type HubRemoteAgent,
} from './hubConnection';

const REQUEST_TIMEOUT_MS = 30_000;

export class HubConnectionService implements IHubConnectionService {
  declare readonly _serviceBrand: undefined;

  private _connection: HubConnection | undefined;

  configure(connection: HubConnection | undefined): void {
    this._connection = connection;
  }

  connection(): HubConnection | undefined {
    return this._connection;
  }

  async listRemoteAgents(): Promise<HubRemoteAgent[]> {
    const data = await this.request('/hub/api/agents');
    const agents = (data as { agents?: unknown } | undefined)?.agents;
    if (!Array.isArray(agents)) {
      throw new Error('unexpected hub response: missing agents list');
    }
    return agents.map((raw) => {
      const agent = raw as Record<string, unknown>;
      const scope = agent['scope'] as { sessions?: unknown } | null | undefined;
      return {
        agentId: typeof agent['agentId'] === 'string' ? agent['agentId'] : '',
        name: typeof agent['name'] === 'string' ? agent['name'] : '',
        platform: typeof agent['platform'] === 'string' ? agent['platform'] : '',
        arch: typeof agent['arch'] === 'string' ? agent['arch'] : '',
        version: typeof agent['version'] === 'string' ? agent['version'] : undefined,
        cwd: typeof agent['cwd'] === 'string' ? agent['cwd'] : undefined,
        connectedAt: typeof agent['connectedAt'] === 'number' ? agent['connectedAt'] : 0,
        sessionIds: Array.isArray(scope?.sessions) ? (scope.sessions as unknown[]).map(String) : [],
        legacy: scope === undefined || scope === null,
      };
    });
  }

  async sendToSession(target: {
    agentId: string;
    sessionId: string;
    text: string;
  }): Promise<HubMessageReceipt> {
    const path = `/agents/${encodeURIComponent(target.agentId)}/api/v1/sessions/${encodeURIComponent(
      target.sessionId,
    )}/prompts`;
    const data = await this.request(path, {
      method: 'POST',
      body: { content: [{ type: 'text', text: target.text }] },
    });
    const item = data as Record<string, unknown> | undefined;
    const status = item?.['status'];
    return {
      promptId: typeof item?.['prompt_id'] === 'string' ? (item['prompt_id'] as string) : '',
      status: status === 'queued' || status === 'blocked' ? status : 'running',
      createdAt: typeof item?.['created_at'] === 'string' ? (item['created_at'] as string) : '',
    };
  }

  private async request(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const connection = this._connection;
    if (connection === undefined) {
      throw new Error('not connected to a kimi hub');
    }
    const url = `${connection.hubUrl.replace(/\/+$/, '')}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: init?.method ?? 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          ...(connection.token === ''
            ? undefined
            : { authorization: `Bearer ${connection.token}` }),
          ...(init?.body === undefined ? undefined : { 'content-type': 'application/json' }),
        },
        ...(init?.body === undefined ? undefined : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new Error(`cannot reach the hub at ${connection.hubUrl}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    let envelope: { code?: unknown; msg?: unknown; data?: unknown };
    try {
      envelope = (await response.json()) as { code?: unknown; msg?: unknown; data?: unknown };
    } catch {
      throw new Error(`hub answered HTTP ${String(response.status)} with a non-JSON body`);
    }
    if (!response.ok || envelope.code !== 0) {
      throw new Error(
        humanizeHubError(
          response.status,
          envelope.code,
          typeof envelope.msg === 'string' ? envelope.msg : 'unknown hub error',
        ),
      );
    }
    return envelope.data;
  }
}

function humanizeHubError(status: number, code: unknown, msg: string): string {
  switch (code) {
    case 40101:
      return `hub authentication failed (${msg}) — check the --token / KIMI_HUB_TOKEN credential`;
    case 40401:
      return 'the target agent is not connected to the hub (it may have just disconnected)';
    case 40302:
      return "the target session is outside its agent's exposed hub scope";
    case 50201:
      return 'the hub could not reach the target agent machine';
    case 50401:
      return 'the hub timed out waiting for the target agent machine';
    default:
      return `hub request failed (HTTP ${String(status)}${typeof code === 'number' ? `, code ${String(code)}` : ''}): ${msg}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.App,
  IHubConnectionService,
  HubConnectionService,
  ScopeActivation.OnDemand,
  'hub',
);
