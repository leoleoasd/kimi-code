/**
 * `hub` domain — `IHubConnectionService` contract.
 *
 * Holds this process's single live kimi-hub connection (hub URL + shared
 * token + the session ids the connection exposes) for the hub-gated agent
 * tools (`ListHubSessions` / `SendHubMessage`). The host's remote-control
 * connector (`kimi remote connect` / the TUI's `/remote connect`) populates
 * it when the tunnel comes up and clears it on disconnect. The service also
 * owns the two outbound HTTPS calls the tools make against the hub: the
 * agent roster read (`GET /hub/api/agents`) and the cross-session prompt
 * submit (`POST /agents/{agentId}/api/v1/sessions/{sessionId}/prompts`).
 * Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface HubConnection {
  readonly hubUrl: string;
  readonly token: string;
  readonly agentName?: string;
  readonly sessionIds: readonly string[];
}

export interface HubRemoteAgent {
  readonly agentId: string;
  readonly name: string;
  readonly platform: string;
  readonly arch: string;
  readonly version?: string;
  readonly cwd?: string;
  readonly connectedAt: number;
  readonly sessionIds: readonly string[];
  /** Legacy connectors declare no scope — the hub exposes their whole machine and they publish no session list. */
  readonly legacy: boolean;
}

export type HubPromptStatus = 'running' | 'queued' | 'blocked';

export interface HubMessageReceipt {
  readonly promptId: string;
  readonly status: HubPromptStatus;
  readonly createdAt: string;
}

export interface IHubConnectionService {
  readonly _serviceBrand: undefined;
  configure(connection: HubConnection | undefined): void;
  connection(): HubConnection | undefined;
  listRemoteAgents(): Promise<HubRemoteAgent[]>;
  sendToSession(target: {
    agentId: string;
    sessionId: string;
    text: string;
  }): Promise<HubMessageReceipt>;
}

export const IHubConnectionService: ServiceIdentifier<IHubConnectionService> =
  createDecorator<IHubConnectionService>('hubConnectionService');
