/**
 * WebSocket upgrades, handled manually on `app.server.on('upgrade')` with
 * `ws` in `noServer` mode — the same shape as kap-server's start.ts, minus the
 * v1 baggage. Three endpoints:
 *
 *   - `TUNNEL_PATH` (`/internal/tunnel`): reverse-tunnel connections from
 *     agents. Handed to `registry.handleConnection`, which authenticates via
 *     the `kimi-hub.bearer.<token>` subprotocol or the `hello` frame's token.
 *   - `/agents/:agentId/api/v1/ws`: browser-side relay. The browser cannot
 *     set headers on a WebSocket, so the token may ride the
 *     `kimi-hub.bearer.<token>` subprotocol instead of `Authorization`.
 *     A virtual tunnel relay is opened first; the upgrade completes only
 *     once the agent's local socket is connected.
 *   - `/hub/api/stream` (exact path): hub-owned roster push channel for the
 *     UI. Authenticated like the browser relay (hub token via the bearer
 *     subprotocol or `Authorization`); immediately sends
 *     `{ "type": "roster", "agents": HubAgentInfo[] }` as bare JSON — NOT the
 *     `{code,msg,data}` REST envelope — and re-sends it on every agent
 *     connect/disconnect via `registry.onChange`.
 *
 * Every upgrade runs the Host-header allowlist FIRST (DNS-rebinding defence,
 * mirroring kap-server). No Origin check beyond that: the hub is
 * single-tenant MVP — every upgrade surface already requires the shared
 * bearer credential, and non-loopback binds are warned about at startup.
 *
 * `--dangerous-bypass-auth` (`disableAuth`): the two BROWSER-facing upgrades
 * (roster stream + agents relay) skip the credential check; the Host
 * allowlist stays on ALWAYS. The `TUNNEL_PATH` auth is not owned here — it is
 * the registry's hello handshake, which `start.ts` relaxes independently via
 * its `trustAnyToken` option.
 */

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { TUNNEL_BEARER_PROTOCOL_PREFIX, TUNNEL_PATH } from '@moonshot-ai/remote-tunnel';
import {
  TunnelError,
  type AgentWsHandle,
  type HubAgentInfo,
  type TunnelRegistry,
} from '@moonshot-ai/remote-tunnel/hub';

import { safeTokenEqual } from '#/auth';
import { filterClientWsFrame, passServerWsFrame } from '#/scope';

export interface HubUpgradeOptions {
  readonly registry: TunnelRegistry;
  readonly token: string;
  /** Host-header allowlist predicate (see `hostnames.ts`). */
  readonly isHostAllowed: (host: string | undefined) => boolean;
  /**
   * `--dangerous-bypass-auth`: the roster-stream and agents-relay upgrades
   * skip the bearer/subprotocol credential check. The Host allowlist is
   * unaffected; the `TUNNEL_PATH` handshake is relaxed through the registry's
   * own `trustAnyToken` option (wired in `start.ts`), not here.
   */
  readonly disableAuth?: boolean;
}

export interface HubUpgradeHandle {
  /** Terminate every accepted socket and close both servers (server shutdown). */
  closeAll(): void;
}

/** `/agents/<agentId>/api/v1/ws` with an optional query string. */
const BROWSER_WS_PATTERN = /^\/agents\/([^/?]+)\/api\/v1\/ws(?:\?(.*))?$/;

/** Roster push channel for the UI; exact path, no query string. */
const ROSTER_STREAM_PATH = '/hub/api/stream';

/** Frame pushed to stream subscribers: bare JSON, no `{code,msg,data}` envelope. */
interface RosterFrame {
  type: 'roster';
  agents: HubAgentInfo[];
}

/** Agent-engine user notification (NotifyUser tool), fanned to every open stream. */
interface NotifyStreamFrame {
  type: 'notify';
  notificationId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string;
  body: string;
}

const UPGRADE_REJECT_REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
};

export function registerUpgradeHandling(
  app: FastifyInstance,
  opts: HubUpgradeOptions,
): HubUpgradeHandle {
  const tunnelWss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectBearerProtocol,
  });
  const browserWss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectBearerProtocol,
  });
  const streamWss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectBearerProtocol,
  });

  // node/http never closes upgraded sockets: every accepted connection is
  // tracked here so `close()` can terminate them. Raw sockets of browser
  // upgrades still awaiting the agent's `ws.opened` are tracked too, so a
  // hung agent cannot wedge shutdown.
  const accepted = new Set<WebSocket>();
  const handshaking = new Set<Duplex>();

  const handleTunnelUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    tunnelWss.handleUpgrade(req, socket as Socket, head, (ws) => {
      accepted.add(ws);
      ws.on('close', () => {
        accepted.delete(ws);
      });
      // The registry authenticates via subprotocol or the hello frame.
      opts.registry.handleConnection(ws);
    });
  };

  const handleBrowserUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    agentId: string,
    path: string,
  ): Promise<void> => {
    let browserWs: WebSocket | undefined;
    // Session-scoped agents: replayed frames are filtered both ways (see
    // scope.ts). The connector can REPLACE its scope over a live tunnel
    // (`scope.update` — the TUI's scope-follow), so the registry's latest set
    // is resolved per frame, not snapshotted at upgrade; unscoped agents pass
    // frames verbatim.
    const scopeSet = (): ReadonlySet<string> | undefined => {
      const sessions = opts.registry.get(agentId)?.scope?.sessions;
      return sessions !== undefined ? new Set(sessions) : undefined;
    };
    let handle: AgentWsHandle;
    try {
      handle = await opts.registry.openAgentWs(agentId, path, {
        onMessage: (data, binary) => {
          if (browserWs === undefined || browserWs.readyState !== WebSocket.OPEN) return;
          const current = scopeSet();
          if (!binary && current !== undefined && !passServerWsFrame(data.toString('utf8'), current)) {
            return;
          }
          browserWs.send(data, { binary });
        },
        onClose: (code, reason) => {
          browserWs?.close(sanitizeCloseCode(code), reason);
        },
      });
    } catch (error) {
      // The agent is gone or its local WS refused: destroy the upgrade socket
      // (the browser client surfaces this as a failed handshake).
      const status =
        error instanceof TunnelError && error.code === 'agent_not_found' ? 404 : 502;
      app.log.warn({ err: error, agentId }, 'agent ws relay open failed');
      rejectUpgrade(socket, status);
      return;
    } finally {
      handshaking.delete(socket);
    }
    if ((socket as Socket).destroyed) {
      // Hub is shutting down; nothing left to upgrade.
      handle.close(1001, 'hub closing');
      return;
    }

    browserWss.handleUpgrade(req, socket as Socket, head, (ws) => {
      browserWs = ws;
      accepted.add(ws);
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          handle.send(rawDataToBuffer(data));
          return;
        }
        const text = rawDataToString(data);
        const current = scopeSet();
        if (current !== undefined) {
          const filtered = filterClientWsFrame(text, current);
          if (filtered === undefined) return; // out-of-scope subscription: dropped
          handle.send(filtered);
          return;
        }
        handle.send(text);
      });
      ws.on('close', (code: number, reason: Buffer) => {
        accepted.delete(ws);
        // Browser died → kill the virtual relay towards the agent.
        handle.close(sanitizeCloseCode(code), reason.length > 0 ? reason.toString('utf8') : undefined);
      });
      ws.on('error', () => {
        // 'close' always follows and owns relay teardown.
      });
    });
  };

  // Engine → hub notifications fan out to every open roster stream (the
  // hub-native channel — session WS relays only cover OPEN chats, and a
  // notification's whole point is reaching the user with no chat open).
  const unsubscribeNotify = opts.registry.onNotify((frame, agent) => {
    const streamFrame: NotifyStreamFrame = {
      type: 'notify',
      notificationId: frame.notificationId,
      sessionId: frame.sessionId,
      agentId: agent.agentId,
      agentName: agent.name,
      title: frame.title,
      body: frame.body,
    };
    const data = JSON.stringify(streamFrame);
    for (const client of streamWss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      try {
        client.send(data, (error) => {
          if (error) client.close();
        });
      } catch {
        client.close();
      }
    }
  });

  const handleStreamUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    streamWss.handleUpgrade(req, socket as Socket, head, (ws) => {
      accepted.add(ws);
      sendRoster(ws, opts.registry);
      const unsubscribe = opts.registry.onChange(() => {
        sendRoster(ws, opts.registry);
      });
      ws.on('close', () => {
        accepted.delete(ws);
        unsubscribe();
      });
      ws.on('error', () => {
        // 'close' always follows and owns the listener cleanup.
      });
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = req.url ?? '';
    if (!opts.isHostAllowed(req.headers.host)) {
      app.log.warn(
        { remoteAddress: req.socket.remoteAddress, path: url, reason: 'host_not_allowed' },
        'ws upgrade rejected',
      );
      rejectUpgrade(socket, 403);
      return;
    }

    if (url === TUNNEL_PATH || url.startsWith(`${TUNNEL_PATH}?`)) {
      handleTunnelUpgrade(req, socket, head);
      return;
    }

    if (url === ROSTER_STREAM_PATH) {
      // Same browser-style rule as the agents relay: subprotocol or header.
      if (opts.disableAuth !== true) {
        const candidate =
          bearerFromAuthorizationHeader(req.headers.authorization) ??
          bearerFromProtocolHeader(req.headers['sec-websocket-protocol']);
        if (candidate === undefined || !safeTokenEqual(candidate, opts.token)) {
          rejectUpgrade(socket, 401);
          return;
        }
      }
      handleStreamUpgrade(req, socket, head);
      return;
    }

    const browserMatch = BROWSER_WS_PATTERN.exec(url);
    if (browserMatch !== null && browserMatch[1] !== undefined) {
      if (opts.disableAuth !== true) {
        const candidate =
          bearerFromAuthorizationHeader(req.headers.authorization) ??
          bearerFromProtocolHeader(req.headers['sec-websocket-protocol']);
        if (candidate === undefined || !safeTokenEqual(candidate, opts.token)) {
          rejectUpgrade(socket, 401);
          return;
        }
      }
      let agentId: string;
      try {
        agentId = decodeURIComponent(browserMatch[1]);
      } catch {
        rejectUpgrade(socket, 400);
        return;
      }
      const path = `/api/v1/ws${browserMatch[2] !== undefined ? `?${browserMatch[2]}` : ''}`;
      handshaking.add(socket);
      void handleBrowserUpgrade(req, socket, head, agentId, path).catch((error: unknown) => {
        handshaking.delete(socket);
        app.log.error({ err: error }, 'ws upgrade handler failed');
        socket.destroy();
      });
      return;
    }

    // Not a hub WS endpoint — the UI (or anything else) must not upgrade here.
    rejectUpgrade(socket, 404);
  };

  app.server.on('upgrade', onUpgrade);

  return {
    closeAll(): void {
      app.server.off('upgrade', onUpgrade);
      unsubscribeNotify();
      for (const socket of handshaking) socket.destroy();
      handshaking.clear();
      for (const ws of accepted) ws.terminate();
      accepted.clear();
      tunnelWss.close();
      browserWss.close();
      streamWss.close();
    },
  };
}

/**
 * Push one roster snapshot; send failures kill the socket (races with a
 * dying socket are possible when an agent leaves just as the browser does).
 */
function sendRoster(socket: WebSocket, registry: TunnelRegistry): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const frame: RosterFrame = { type: 'roster', agents: registry.list() };
  try {
    socket.send(JSON.stringify(frame), (error) => {
      if (error) socket.close();
    });
  } catch {
    socket.close();
  }
}

/** Echo back the offered `kimi-hub.bearer.*` subprotocol (or none). */
function selectBearerProtocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) {
    if (protocol.startsWith(TUNNEL_BEARER_PROTOCOL_PREFIX)) {
      return protocol;
    }
  }
  return false;
}

function bearerFromAuthorizationHeader(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return undefined;
  }
  const token = authorization.slice('Bearer '.length);
  return token.length === 0 ? undefined : token;
}

function bearerFromProtocolHeader(protocolHeader: string | undefined): string | undefined {
  if (protocolHeader === undefined) {
    return undefined;
  }
  for (const entry of protocolHeader.split(',')) {
    const protocol = entry.trim();
    if (protocol.startsWith(TUNNEL_BEARER_PROTOCOL_PREFIX)) {
      const token = protocol.slice(TUNNEL_BEARER_PROTOCOL_PREFIX.length);
      return token.length === 0 ? undefined : token;
    }
  }
  return undefined;
}

/**
 * Codes 1004/1005/1006/1015 are reserved: a peer that vanished without a
 * close frame reports one, and both `ws` and browsers THROW when asked to
 * send it back. Normalize to 1000 before mirroring a close across the relay.
 */
function sanitizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    return 1000;
  }
  return code;
}

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = UPGRADE_REJECT_REASONS[status] ?? 'Error';
  try {
    (socket as Socket).write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } catch {
    // Socket already dead — destroy below is a no-op then.
  }
  (socket as Socket).destroy();
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rawDataToString(data: RawData): string {
  return rawDataToBuffer(data).toString('utf8');
}
