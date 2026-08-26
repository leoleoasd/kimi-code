# kimi-hub — decoupled web UI + reverse-tunnel hub

Standalone app that decouples the kimi-code web UI from the agent engine so UI
and agents can run on different machines. Effect: like Claude Code's remote
control — agents on any machine run `kimi remote connect <hub-url>`, and one
hub web UI lists and controls all their sessions.

## Layout

- `server/` (`@moonshot-ai/kimi-hub-server`) — Fastify hub: tunnel registry,
  per-agent protocol-transparent proxy, static web UI host, bearer auth.
- `web/` (`@moonshot-ai/kimi-hub-web`) — React + Vite UI. Talks ONLY to this
  hub (never cross-origin to agents) over the contract below.
- Shared tunnel frame protocol: `packages/remote-tunnel/src/protocol.ts`
  (`@moonshot-ai/remote-tunnel`, subpath exports `/hub` and `/agent`).

## How it works

1. Agent machine: `kimi remote connect <hub-url> --session <id> --token <t> [--name <n>]`
   (TUI: `/remote connect`) starts (or attaches to) a loopback-only kap-server,
   then dials OUT to the hub via `@moonshot-ai/remote-tunnel/agent`.
   NAT/firewall safe: agents never listen on a reachable port. The boot banner
   prints both forms as paste-ready lines (`connectBannerLines` in
   `server/src/banner.ts`) with the live origin/token and `<session-id>` left
   as a literal placeholder for the user to edit — in bypass mode the lines
   drop the `--token` segment (see Auth below).
2. Hub terminates the tunnel at `WS /internal/tunnel` and registers the agent.
3. Browser opens the hub UI (same-origin). For a selected agent, the UI uses
   base URL `<hub-origin>/agents/<agentId>` and then speaks the UNCHANGED
   kap-server production protocol (`/api/v1` REST + `/api/v1/ws` WS; contract
   types from `@moonshot-ai/transcript`). The hub strips the prefix and relays
   bytes through the tunnel, enforcing the agent's session scope (below) —
   no kap-server protocol reimplementation.
4. Composer `/…` commands forward VERBATIM to the agent's command bridge
   (`POST :command` + `GET …/commands` for the hint popover; see kap-server's
   `transport/commandBridge.ts`) — the connected TUI's own dispatch executes,
   so the web keeps NO command table of its own (only `/copy` and
   `/export-debug-zip` run browser-locally, their substance being the
   browser). The bridge returns the lines the TUI surfaced; picker-type
   commands park in the TUI and the bridge reports them as interactive.

## Hub URL contract (the fixed interface web/ codes against)

- `GET /hub/api/agents` → `{ agents: HubAgentInfo[] }` where
  `HubAgentInfo = { agentId, name, platform, arch, version?, cwd?, pid?, connectedAt, scope?: { sessions: string[] } }`
  (`connectedAt` is epoch ms; `agentId` is per-connection, a fresh id on
  reconnect with the same `name`; `pid` is an OPT-IN: only self-identified
  daemons declare it — `kimi headless` passes its own pid, interactive hosts
  like the TUI `/remote connect` deliberately do not, because a present pid
  makes the agent stoppable through the hub: the proxy forwards
  `POST /api/v1/shutdown` for scoped agents only when the roster entry carries
  one, and the web UI gates its stop button on the same field). Connections can be per-session: a scoped
  agent's `scope.sessions` lists the session ids it exposes, and the web UI
  renders those as one FLAT remote-session list (session-centric, agent shown
  as subtitle). Agents without `scope` are legacy connectors — the UI keeps a
  bottom "legacy agents" drill-in (per-agent session list + "new session";
  scoped agents cannot create). A dropped scoped agent keeps grey,
  non-interactive offline rows until it reconnects.
- `WS /hub/api/stream` → the hub's own roster push channel (bearer
  subprotocol auth like the other hub sockets). On open, and again on every
  roster change, it sends a bare, ENVELOPE-FREE snapshot
  `{ "type": "roster", "agents": HubAgentInfo[] }`. The web UI overlays these
  frames onto the same react-query key the 5s REST poll writes (the poll
  stays as fallback), and shows an "agent offline" banner on an open chat
  whose agent has no live roster entry.
- HTTP proxy: `ALL /agents/{agentId}/api/v1/*` and `/agents/{agentId}/api/v2/*`
  → forwarded to the agent's local kap-server, response relayed verbatim
  (status + headers + bytes), subject to the agent's session scope (next
  section). Hop-by-hop headers and the caller's `Authorization` are stripped;
  the connector injects the agent-local token.
- WS proxy: `WS /agents/{agentId}/api/v1/ws` → virtual relay to the agent's
  kap-server WS, text/binary preserved, scope-filtered for scoped agents.
- Agent-initiated hub calls: a connected agent's engine tools
  (`ListHubSessions` / `SendHubMessage`) also reach the hub WITHOUT the
  browser — plain HTTPS with the same shared token: `GET /hub/api/agents`
  (roster read) and the proxied
  `POST /agents/{otherAgentId}/api/v1/sessions/{sid}/prompts` (target must be
  a session the OTHER agent exposes; its scope filter applies as usual).
- Static UI: `GET /` + SPA fallback (serves `web/dist` in production; in dev
  the Vite dev server on 5173 proxies `/hub`, `/agents`, `/internal` to the
  hub server).

## Agent session scope

Model: Claude Code remote control's 1:1 session bridge — a connection exposes
ONLY the session(s) it was connected for, never the whole machine. The
CONNECTOR declares the scope at hello (`kimi remote connect --session <id>`
always does; the TUI `/remote connect` auto-scopes to the current session),
and the HUB enforces it server-side (`server/src/scope.ts`). For a scoped
agent with session set `S`:

- REST (path after stripping `/agents/:agentId`):
  - always allowed: `GET /api/v1/healthz`, `GET /api/v1/meta`, `GET /api/v1/auth`;
  - `/{v1|v2}/sessions/{sid}/...` (any subpath, any method): allowed iff `sid ∈ S`;
  - `GET /api/v1|v2/sessions`: proxied, then the successful envelope's
    `data.*` session arrays are filtered to `id ∈ S` (a non-envelope body
    passes unchanged);
  - everything else — session create, host surfaces, workspaces, …: `403`
    with `code 40302`, msg `session-scoped agent: <reason>`.
- WS (`/agents/:agentId/api/v1/ws`): browser → hub `subscribe` frames are
  rewritten to `session_ids ∩ S` and dropped when empty (session-keyed
  `cursors` / `watch_fs` / `agent_filter` filtered likewise);
  `subscribe_v2` / `unsubscribe_v2` for `session_id ∉ S` are dropped.
  Hub → browser JSON frames carrying a top-level `session_id ∉ S` are
  dropped; frames without one pass (`transcript.*` frames only ever flow for
  already-filtered subscriptions).
- An agent WITHOUT `scope` (older connector) is unscoped: full verbatim
  proxy, the legacy whole-machine behavior. Backward compatibility is a hard
  requirement — never make scope mandatory in the tunnel protocol.
- A scoped connection may rewrite its declared scope over a LIVE tunnel with
  a `scope.update` frame: the hub replaces the set verbatim (union bookkeeping
  is the connector's job — the TUI's `/remote connect` grows a union as the
  user moves between sessions, `kimi remote connect --session` stays fixed).
  Hub-side enforcement resolves `registry.get(agentId).scope` per
  request/frame, so a widened set takes effect immediately, including on
  already-open browser sockets.

## Auth

One shared hub token (single-user model): `--token`, `KIMI_HUB_TOKEN`, or
generated+printed at boot. Every `/hub/*`, `/agents/*`, `/internal/*` surface
requires it:

- Browser REST: `Authorization: Bearer <token>`.
- Browser/agent WebSocket: subprotocol `kimi-hub.bearer.<token>` (see
  `kimi-hub.bearer.` handling in `@moonshot-ai/remote-tunnel` — browser WS
  cannot set headers).
- UI bootstrap: `#token=` fragment or `?token=` query (stored in
  sessionStorage, mirroring the production UI's convention — never sent over
  the wire as part of a URL).

`--dangerous-bypass-auth` (mirrors `kimi web`) skips that gate on BOTH ends of
the wire and prints a loud banner warning; the Host allowlist is lifted too
(reverse proxies / tunnel domains forward arbitrary Host values).
Browser surfaces drop their checks (HTTP hook + roster-stream/agents-relay WS
upgrades), and `startHub` creates the tunnel registry with
`trustAnyToken: true` (`createTunnelRegistry` option), so the
`/internal/tunnel` hello handshake accepts ANY or NO token — a
mismatched/absent `kimi-hub.bearer.*` subprotocol and any/absent
`hello.token` both pass (the protocol version check still rejects);
connectors presenting the banner token keep working unchanged. The banner's
paste-ready connect lines omit `--token` in this mode. The web UI's authless
"continue" stores the EMPTY string in `sessionStorage[kimi-hub.token]` as the
sentinel; every transport omits the header/subprotocol for it (never
`Bearer ` empty).

## Native binary (SEA)

`pnpm --filter @moonshot-ai/kimi-hub-server run build:native` produces a
self-contained Node SEA executable at
`server/dist-native/bin/<platform-triple>/kimi-hub` (e.g. `linux-x64`).
Pipeline (all in `server/scripts/build-native.mjs`): `tsdown
--config tsdown.dist-native.config.ts` bundles `src/main.ts` into a single
CommonJS `dist-native/intermediates/main.cjs` (SEA mains must be CJS — ESM
blob generation succeeds but the embedded entry fails at runtime) with every
dependency bundled; `scripts/sea-assets.mjs` collects `web/dist` into a sea
config (one `web/dist/<posix path>` asset per file plus the
`web/assets-manifest.json` manifest; contract in `scripts/sea-manifest.mjs`);
`node --experimental-sea-config` builds the blob; `postject` injects it into a
copy of the current `node` binary. `pnpm run build:native:smoke` appends a
live smoke: boot from a non-repo cwd, `GET /`, 401/200 auth gate on
`/hub/api/agents`, clean SIGINT.

Web asset selection at runtime (`server/src/routes/webAssets.ts`): an
explicit `--web-dist` always wins (filesystem mode, the dev default);
otherwise a SEA binary (`sea.isSea()`) serves the embedded blob via
`sea.getRawAsset` against the manifest. `--web-dist` therefore still works on
the binary to override the embedded bundle. The binary needs no repo layout.

## Notes / non-goals (MVP)

- Machine-local surfaces stay per-agent by design (host fs browsing, PTY
  terminals, file upload); a scoped agent cannot reach them at all (40302).
- Session scope is per-CONNECTION and connector-declared: it narrows what one
  tunnel exposes. It is not a multi-user ACL — the single shared hub token
  already gates every surface; a machine wanting two remote-controlled
  sessions runs two `remote connect` tunnels, one per session.
- `fs:open`/`fs:open-in`/`fs:reveal` execute on the AGENT machine.
- Single shared credential; not multi-tenant. Bind the hub to loopback or put
  it behind your own TLS proxy for real deployments (`--host`,
  `--insecure-no-tls` mirrors `kimi web`).
- Per-connection `agentId`: a reconnecting agent gets a new id; the UI should
  re-resolve agents by `name`.
