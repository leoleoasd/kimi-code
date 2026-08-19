
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
    const parsed = agents.map((raw): HubRemoteAgent => {
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
        sessionTitles: {},
        legacy: scope === undefined || scope === null,
      };
    });
    await Promise.all(
      parsed.map(async (agent, index) => {
        if (agent.legacy || agent.sessionIds.length === 0) return;
        try {
          parsed[index] = {
            ...agent,
            sessionTitles: await this.fetchSessionTitles(agent.agentId, agent.sessionIds),
          };
        } catch {
        }
      }),
    );
    return parsed;
  }

  private async fetchSessionTitles(
    agentId: string,
    sessionIds: readonly string[],
  ): Promise<Record<string, string>> {
    const data = await this.request(
      `/agents/${encodeURIComponent(agentId)}/api/v2/sessions?page_size=100`,
    );
    const items = (data as { items?: unknown } | undefined)?.items;
    const titles: Record<string, string> = {};
    if (!Array.isArray(items)) return titles;
    const wanted = new Set(sessionIds);
    for (const item of items) {
      const entry = item as Record<string, unknown> | null;
      const meta = entry?.['meta'] as Record<string, unknown> | null | undefined;
      const title = meta?.['title'];
      const id = entry?.['id'];
      if (typeof id === 'string' && wanted.has(id) && typeof title === 'string' && title !== '') {
        titles[id] = title;
      }
    }
    return titles;
  }

  async sendToSession(target: {
    agentId: string;
    sessionId: string;
    text: string;
    steer?: boolean;
  }): Promise<HubMessageReceipt> {
    const path = `/agents/${encodeURIComponent(target.agentId)}/api/v1/sessions/${encodeURIComponent(
      target.sessionId,
    )}/prompts`;
    const data = await this.request(path, {
      method: 'POST',
      body: { content: [{ type: 'text', text: target.text }], steer: target.steer },
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
