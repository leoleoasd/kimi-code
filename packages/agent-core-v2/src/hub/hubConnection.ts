
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface HubConnection {
  readonly hubUrl: string;
  readonly token: string;
  readonly agentName?: string;
  /**
   * Live read of the hub-assigned agent id (it changes on every tunnel
   * reconnect, so it is a thunk, not a snapshot). `undefined` until the first
   * `hello.ack`. Used to build machine-reachable callback URLs through the
   * hub's `/agents/<agentId>` proxy.
   */
  readonly agentId?: () => string | undefined;
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
  /**
   * session id → display title, resolved lazily through the agent's own
   * session list (proxied by the hub); only sessions with a non-empty title
   * are present, and the map is empty when the lookup failed.
   */
  readonly sessionTitles: Readonly<Record<string, string>>;
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
    /**
     * Ask the receiver's server to inject the message into its active turn
     * (steer) instead of leaving it in the prompt FIFO. Degrades to the
     * queued/launched behavior when there is nothing to steer into.
     */
    steer?: boolean;
  }): Promise<HubMessageReceipt>;
}

export const IHubConnectionService: ServiceIdentifier<IHubConnectionService> =
  createDecorator<IHubConnectionService>('hubConnectionService');
