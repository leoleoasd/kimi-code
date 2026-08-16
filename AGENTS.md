# Repository-level Agent Guide

Reply in the same language as the user.

This repo is **leoleoasd's fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)**. Upstream is the agentic coding assistant whose primary product is the `kimi` CLI / TUI; the fork keeps the whole product and adds its own layer on top — the kimi-hub remote-control stack (`apps/kimi-hub` + `packages/remote-tunnel`), agent-driven notifications, and its own binary release pipeline. It is a TypeScript pnpm monorepo: the CLI, its agent engines, the supporting server/client packages, a VS Code extension, remote-control tooling, and the docs site.

Treat code, not documentation, as the source of truth. Keep this root `AGENTS.md` limited to hot-path rules — project map, hard constraints, workflow requirements — and follow the nearest `AGENTS.md` in the directory tree for deeper rules.

## Git Setup and Upstream Relationship

This is the section that most often gets wrong if you copy upstream habits.

- Remotes: `leoleoasd` → `git@github.com:leoleoasd/kimi-code.git` (the fork; all branches, pushes, and PRs go here). `origin` → `https://github.com/MoonshotAI/kimi-code.git` (upstream; fetch-only in practice).
- Local `main` is the fork's mainline and is identical to `leoleoasd/main`; it currently tracks `origin/main` (upstream), so `git status` shows the fork delta as "ahead N". Branch new work off local `main`, **not** off `origin/main` — branching off `origin/main` drops the entire fork delta (the user-level workflow file says `origin/main`; for this repo that means upstream and must not be used as the branch base).
- When invoking `gh`, always pass `-R leoleoasd/kimi-code` explicitly (issues, PRs, releases). Never push branches to, or open PRs from this checkout against, the upstream `origin` repo.
- The fork delta is a linear stack of commits on top of upstream (`git log --oneline origin/main..main` to inspect; as of 2026-08 it is 16 commits, mainline is also behind upstream by a few commits). Upstream syncs replay this stack over the new `origin/main`; after any sync, rerun `pnpm install && pnpm typecheck && pnpm test`.
- The fork delta is concentrated in: `apps/kimi-hub/**`, `packages/remote-tunnel/**`, the `remote` surfaces in `apps/kimi-code`, kap-server's command bridge / transcript service, agent-core-v2's notify-user tool, `.github/workflows/`, `install.sh`, `scripts/`, README's fork header. Upstream churn in those files is where sync conflicts land.

## What This Fork Adds (delta over upstream)

- `apps/kimi-hub`, `apps/kimi-hub/server`, `apps/kimi-hub/web`: the decoupled remote-control hub — a standalone web UI plus a hub server that agents dial out to (`kimi remote connect` / TUI `/remote connect`) via `@moonshot-ai/remote-tunnel`; the hub proxies the unchanged kap-server protocol per agent (`/agents/{id}/api/v1|v2/*` + WS), so sessions on many machines are controlled from one page. See `apps/kimi-hub/AGENTS.md`.
- `packages/remote-tunnel`: the reverse WebSocket tunnel between kimi-hub and outbound-connected agents — one WS per agent multiplexes id-keyed HTTP round trips and virtual WS relays. Subpath entries: `.` (fixed wire protocol), `/hub` (`createTunnelRegistry`), `/agent` (`startTunnelClient`).
- Remote-control surfaces in `apps/kimi-code`: the `kimi remote connect` CLI subcommand (`src/cli/sub/remote/`) and the TUI `/remote connect|status|disconnect` slash commands (`src/tui/commands/remote.ts`, `remote-bridge.ts`). TUI attach scopes the live session without a restart.
- kap-server host-injection seams (fork-updated `packages/kap-server/AGENTS.md` has the details): an embedding host (the TUI's `/remote connect`) passes a live engine via `ServerStartOptions.core`; `ServerStartOptions.commandBridge` (`src/transport/commandBridge.ts`) exposes the host's slash-command grammar remotely — `POST /sessions/{id}:command` runs a raw line, `GET /sessions/{id}/commands` powers composer hints; unbridged servers answer `40418 command.unavailable` + an empty catalog.
- Agent notifications: the agent-core-v2 `notify-user` tool (`packages/agent-core-v2/src/agent/tools/notify-user/`) lets the agent emit OS/browser notifications; through kimi-hub this extends to Web Push that wakes devices with the page closed (VAPID subject real-host requirement, dead-subscription pruning, re-subscribe after rotation, suppression while a hub page is open).
- Cross-session messaging over the hub: while a remote-control connection is up, agents gain `ListHubSessions` + `SendHubMessage` — the hub roster read and a wrapped user-role prompt delivery to another session, both via plain HTTPS with the shared token (the tunnel protocol has no agent→hub channel). Delivery rides the `steer: true` flag on prompt submission (kap-server's `POST /sessions/{id}/prompts`): a busy target gets the message injected into its active turn at the next step boundary (degrading to the plain FIFO when there's nothing to steer into), and the wrapper instructs it to answer, then continue its work. Engine keeps the connection in App-scope `IHubConnectionService` (`packages/agent-core-v2/src/hub/`); the connectors register the tools per agent directly (`apps/kimi-code/src/cli/sub/remote/shared.ts` `wireHubTools`), so they vanish when the link drops.
- `--dangerous-bypass-auth` on both `kimi web` and `kimi-hub`: skips the token gate end to end and lifts the Host allowlist (reverse proxies / tunnel domains forward arbitrary Host values); the hub's web UI then skips the token form.
- Fork-local accuracy fixes in the transcript stack (`packages/transcript` fold/group layers, kap-server's `services/transcript/coreEventMap.ts`) and TUI render fixes (engine-queue mirroring in `session-event-handler`, thinking frames pinned to two visual rows).
- Fork release pipeline: `.github/workflows/fork-release.yml` + `install.sh` (see Release Process and CI below).

## Project Map (full tree)

- `apps/kimi-code` (`@moonshot-ai/kimi-code`, publishable): the CLI / TUI application providing the `kimi` command. It consumes core capabilities through `@moonshot-ai/kimi-code-sdk` and must not depend directly on `@moonshot-ai/agent-core`. Also ships native single-executable (SEA) bundles via `build:native:sea` (`scripts/native/`). See `apps/kimi-code/AGENTS.md`; when writing or modifying its terminal UI, use the `write-tui` skill (`.agents/skills/write-tui/SKILL.md`).
- The browser web UI: **its source no longer lives in this repo.** It is developed in the code-app repo (`apps/web`) and shipped as the committed, prebuilt bundle `apps/kimi-code/dist-web` (gitignored, force-added), synced from code-app with `KIMI_CODE_REPO=<this checkout> pnpm run sync:web` — sync and commit the bundle in the same change whenever the web UI should ship differently. `apps/kimi-code/scripts/check-web-assets.mjs` guards packaging against a missing bundle. To hack on the web UI against this repo's server, run `pnpm dev:server` here and point code-app's `pnpm dev:web` at it via `KIMI_SERVER_URL`.
- `apps/vscode` (`kimi-code`): the official VS Code extension.
- `apps/vis`, `apps/vis/server`, `apps/vis/web`: visual debugging tools for sessions and replays.
- `apps/kimi-inspect`: web inspector for the kap-server `/api/v1/debug` RPC surface — workspace/session browser, per-session transcript chat, per-scope Service panels, and the DI unit inspection view. See `apps/kimi-inspect/AGENTS.md`.
- `apps/kimi-hub` + `server` + `web`: the fork's remote-control hub. See the delta section above and `apps/kimi-hub/AGENTS.md`. Run from source: `pnpm dev:hub` (or `pnpm -C apps/kimi-hub build && pnpm -C apps/kimi-hub start`).
- `packages/agent-core`: the unified agent engine (v1), including Agent, Session, profile, skills, tools, plan, permission, background, records, the in-process DI service layer (`src/services/`), and other core capabilities. See `packages/agent-core/AGENTS.md`.
- `packages/agent-core-v2`: the DI × Scope agent engine (the v2 port behind kap-server). Four `LifecycleScope` tiers — `App` / `Workspace` / `Session` / `Agent` (`app/scopes.ts`) — plus the L3 unit layer (`Service`/`Fiber` units, collection contribution points, the Feature seam in `src/features/`); there is no App-level session lifecycle facade — callers compose `ISessionIndex` → `IWorkspaceLifecycleService.handlerFor` → the handler. See `packages/agent-core-v2/AGENTS.md` and use the `agent-core-dev` skill (`.agents/skills/agent-core-dev/SKILL.md`) when developing here.
- `packages/kap-server`: the Kimi Code server, backed by `@moonshot-ai/agent-core-v2`; exposes sessions over REST + WebSocket (`/api/v1` + `/api/v1/ws`), plus the `/api/v1/debug/*` reflection RPC surface (`--debug-endpoints`, loopback bind + bearer auth). See `packages/kap-server/AGENTS.md` — the fork appended the host-injection seams (`core`, `commandBridge`).
- `packages/klient`: the client SDK — a contract-driven facade over agent-core-v2 (`global.*` / `session(id).*` / `agent(id).*`, zod-validated); transport via subpath entry (`@moonshot-ai/klient/ipc|memory`, both return the same `Klient`); also hosts the e2e suites. See `packages/klient/AGENTS.md`.
- `packages/node-sdk` (`@moonshot-ai/kimi-code-sdk`, publishable): the public TypeScript SDK and harness.
- `packages/protocol`: shared REST + WS wire schemas (envelope, error codes, pagination, ws-control) for the daemon.
- `packages/kosong`: the LLM / provider abstraction layer.
- `packages/kaos`: the execution environment and file/process abstractions.
- `packages/oauth` (`@moonshot-ai/kimi-code-oauth`): Kimi OAuth and managed auth utilities.
- `packages/telemetry` (`@moonshot-ai/kimi-telemetry`): shared client-side telemetry infrastructure.
- `packages/transcript`: the isomorphic transcript rendering data layer — L1 agent-granular store, L2 idempotent operations, L3 `off/turn/block/delta` subscription granularity, L4 framework-free view registry, plus turn-cursor pagination. Pure TypeScript (browser-safe, no engine imports); the sole owner of the transcript contract types (`src/contract/`) and the op-batch sequencing contract. See `packages/transcript/AGENTS.md`.
- `packages/remote-tunnel`: the fork's reverse WS tunnel. See the delta section above.
- `packages/tree-sitter-bash`: a pure-TypeScript bash parser (no runtime deps, no wasm); `parse(source, { timeoutMs, maxNodes })` runs under a deterministic budget and returns a discriminated `ParseResult` — callers must treat aborted/hasError trees as "cannot analyze" and degrade. Parser only, no safety judgments; see the package README's "Known differences" section.
- `packages/minidb`: the embedded JSON document store (`MiniDb`) behind kap-server's search index — snapshot + WAL persistence with an exclusive write lock, a larger-than-RAM full-text layer, and persistent index generations. See `packages/minidb/AGENTS.md`.
- `packages/pi-tui`: the terminal-UI rendering library (differential rendering) that the TUI is built on. See `packages/pi-tui/AGENTS.md`.
- `packages/acp-adapter`, `packages/acp-server`: Agent Client Protocol support — the adapter for kimi-code and an ACP host backed directly by agent-core-v2.
- `packages/migration-legacy`: migrates kimi-cli (`~/.kimi/`) data into kimi-code (`~/.kimi-code/`).
- `docs/`: the bilingual (zh/en) VitePress documentation site. See `docs/AGENTS.md`.
- `plugins/`: bundled official plugins (`kimi-datasource`, `kimi-webbridge`) plus `marketplace.json`. Plugins are versioned in each plugin's `kimi.plugin.json` / `plugins/marketplace.json` and shipped via the marketplace CDN — they do not go through changesets.
- `build/`: shared bundler helpers (`?raw` text imports) used by package builds; `scripts/`: repo helper scripts (`install-dev.mjs` — fork-added dev installer; `check-nix-workspace.mjs`, `check-service-naming.mjs`, `fix-node-pty-perms.mjs`).
- `.agents/skills/`: agent skills local to this repo (`write-tui`, `agent-core-dev`, `agent-core-review`, `gen-changesets`, `gen-docs`, `translate-docs`, `sync-changelog`, `pre-changelog`).

## Working Principles

- Think from first principles. Start from real requirements, code facts, and verification results; if the goal is unclear, discuss it with the user first.
- Before making code changes, read the relevant code and the most recent constraints, and follow the nearest `AGENTS.md` in the directory tree (`packages/kap-server/AGENTS.md` and `apps/kimi-hub/AGENTS.md` carry fork-authored rules; the other nested files are upstream-authored but still describe unchanged code).
- Keep changes focused. Do not slip in unrelated refactors along the way.
- When committing, do not add any co-author attribution, and do not reveal the identity of the agent in commit messages, PR descriptions, or any explanatory text.

## Environment Requirements

- **Node.js**: `>=24.15.0` (root `package.json` `engines`; `.nvmrc` is `24.15.0`).
- **pnpm**: `10.33.0` (root `package.json` `packageManager`); `.npmrc` sets `engine-strict=true`, so `pnpm install` fails on a wrong Node version.

## Common Commands

Run from the repo root (the `Makefile` mirrors the upstream subset as `make <target>`; the fork-added targets `dev:hub` and `install:local` have no Makefile entry):

- `pnpm install` — install; `postinstall` fixes `node-pty` permissions.
- `pnpm build` — build all workspaces recursively (`build:packages` builds only `packages/*`).
- `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` — vitest across workspace projects.
- `pnpm typecheck` — builds packages first, then typechecks packages + the app workspaces (including hub server/web).
- `pnpm lint` / `pnpm lint:fix` — `oxlint --type-aware` (with `--fix`).
- `pnpm sherif` — monorepo dependency-consistency check.
- `pnpm dev:cli` — the CLI in dev mode; `pnpm dev:server` / `pnpm dev:kap-server` — the server; `pnpm dev:hub` — the kimi-hub (fork); `pnpm vis` — the session visualizer; `pnpm dev:docs` — the docs site.
- `pnpm install:local` (fork) — rebuild the `kimi` + `kimi-hub` SEA binaries and atomically install them into `~/.kimi-code/`'s bin dir (`scripts/install-dev.mjs`); running binaries keep their old inode.
- `pnpm changeset` — add a release changeset (see Release Process below).
- `pnpm publish` — the upstream release gate (typecheck → lint → sherif → test → build → `lint:pkg` → `changeset publish`). The npm publish leg needs MoonshotAI's OIDC identity and does not work from the fork; distribution here goes through the Fork Release workflow instead.

## Testing

- Tests run under vitest. The root `vitest.config.ts` composes per-workspace projects: `packages/*`, `apps/kimi-code`, `apps/vscode`, `apps/kimi-hub/server`, and `apps/kimi-hub/web` (`apps/vis` and `apps/kimi-inspect` are not covered); most workspaces carry their own `vitest.config.ts`.
- Heavier e2e suites live in `packages/klient/test/e2e/` (driven through the klient transports) and in `apps/kimi-code` (`pnpm -C apps/kimi-code e2e`; `e2e:real` talks to real providers).
- Do not add too many new test files. Prefer adding tests to the existing test file of the corresponding component or module.
- When a test fails because of a user modification, default to fixing the test first; do not change the implementation to satisfy an old test unless the implementation truly has a bug.

## Code Style

- TypeScript everywhere, ESM (`"type": "module"` at the root).
- Linting via `oxlint` (config in `.oxlintrc.json`, run with `--type-aware`); formatting conventions live in `.oxfmtrc.json` (oxfmt: 100-col, single quotes, trailing commas, sorted imports). `lint-staged` runs `oxlint --fix` + a type-aware pass on staged TS/JS files.
- `packages/agent-core-v2`, `packages/kap-server`, and `packages/transcript` are comment-free zones: no line/block comments; the exceptions are JSDoc attached to exported symbols and load-bearing lint-suppression directives (`oxlint-disable` / `eslint-disable`), while other tooling directives (`@ts-expect-error`, …) stay banned. Enforced by `scripts/check-no-comments.mjs`, which runs as part of `pnpm lint`.
- For optional object properties, pass `undefined` directly instead of using conditional spread.
  - YES: `{ user }`
  - NO: `{ ...(user ? { user } : undefined) }`
- Optional object properties do not need to additionally allow `undefined` in the type.
  - YES: `interface Options { user?: User }`
  - NO: `interface Options { user?: User | undefined }`
- Internal methods with only a single parameter should not be turned into options objects just for stylistic uniformity.
- Except for a package's `index.ts`, other `index.ts` files should prefer `export * from './module';`.
- Prefer importing via `import ... from '#/...'`, which serves the same purpose as `import ... from '@/...'`.
- Do not sacrifice code quality for external compatibility unless the user explicitly asks for it. Breaking changes go through changesets and a `major` bump, gated by the rule in Release Process.

## Monorepo Workspace Maintenance

- `pnpm-workspace.yaml` is the source of truth for workspace membership (`packages/*`, `apps/*`, `apps/kimi-hub/{server,web}`, `apps/vis/{server,web}`, `docs`), but `flake.nix` also contains **hardcoded** `workspacePaths` and `workspaceNames` lists.
- **Whenever you add or remove a workspace package, you MUST update both `pnpm-workspace.yaml` and `flake.nix` — for every package, including leaf / test / e2e packages that nothing depends on.** (`packages/remote-tunnel` and `apps/kimi-hub/*` are already registered in both.)
- New private packages also need to be added to the `ignore` list in `.changeset/config.json` (the fork did this for `@moonshot-ai/kimi-hub*`, `@moonshot-ai/remote-tunnel`).
- The automated "Check flake.nix workspace sync" (`scripts/check-nix-workspace.mjs`) only validates the transitive dependency **closure of `@moonshot-ai/kimi-code`**. A green check is NOT proof that `flake.nix` is fully in sync — keep it updated by hand on every add/remove.

## Experimental Features

- Gate a not-yet-public feature behind an experimental flag. Flags are env-driven and default off: `KIMI_CODE_EXPERIMENTAL_<NAME>` toggles one, `KIMI_CODE_EXPERIMENTAL_FLAG` enables all. Release by flipping the entry's `default` to `true`.
  - `packages/agent-core` (v1): add the flag to the central registry at `packages/agent-core/src/flags/registry.ts`, then check it with `flags.enabled('my-feature')`.
  - `packages/agent-core-v2` and kap-server modules: declare the flag in the owning domain via `registerFlagDefinition` at import time (see `packages/agent-core-v2/docs/flag.md`), then check it with `IFlagService.enabled(id)`. Current search-index-separation flags: `persistence_minidb_readmodel` and `search_worker` (both default on).

## Release Process (fork)

- Versioning is changesets-based, same as upstream (see `.changeset/README.md` and the `gen-changesets` skill). Only two packages are publishable to npm: `@moonshot-ai/kimi-code` and `@moonshot-ai/kimi-code-sdk`; all other workspaces are private internals. The fork still writes changesets and runs `pnpm version` to bump versions; do NOT run `changeset publish` / `pnpm publish` — npm Trusted Publishing (OIDC) belongs to MoonshotAI.
- **Fork distribution = GitHub Releases on `leoleoasd/kimi-code`.** The "Fork Release" workflow (`.github/workflows/fork-release.yml`) triggers on `workflow_dispatch` (pick a tag) or by pushing a tag matching `fork-v*`; it builds the CLI native bundles (linux/darwin/win32 × x64/arm64 via the reusable `_native-build.yml`) and the `kimi-hub` SEA executables (linux/darwin × x64/arm64, with the hub web UI embedded), then publishes all zips + sha256s as release assets. Keep fork releases marked non-prerelease: `install.sh` resolves the latest non-prerelease release.
- `install.sh` (repo root, raw.githubusercontent URL on the fork's `main`) installs `kimi` + `kimi-hub` from those releases into `~/.local/bin` (`--cli-only` / `--hub-only`, `--install-dir`, `--version`; env `KIMI_FORK_REPO`, `KIMI_INSTALL_DIR`). It falls back to python3's zipfile when `unzip` is missing. Windows users download the `win32-*` archive manually.
- After finishing a task and before submitting a PR, run the `gen-changesets` skill (`.agents/skills/gen-changesets/SKILL.md`) and generate a changeset under `.changeset/` according to its rules. Never decide on a `major` bump on your own — stop, explain, and get explicit user confirmation first; default to `minor`, fall back to `patch`.

## CI

- The fork has exactly two workflows: `_native-build.yml` (reusable native-bundle build) and `fork-release.yml` (manual/`fork-v*` tag releases to GitHub Releases on the fork); the upstream pipelines (`ci.yml`, `release.yml`, `nix-build.yml`, docs/pkg-pr-new/pr-title-checker, …) were removed. **There is no automatic PR CI in the fork**, so run `pnpm lint`, `pnpm typecheck`, and `pnpm test` locally before opening or merging a PR; do not assume a workflow will catch failures.
- Upstream's PR bodies enforce Conventional Commit titles via a checker workflow; that workflow does not exist here, but keep the same convention (e.g. `chore: remove legacy format commands`) so history stays upstream-shaped.

## Security Considerations

- Report vulnerabilities privately per `SECURITY.md`, not as public issues.
- In public text and test data, replace real internal identifiers with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY`. Before opening a PR, ask a read-only agent to audit the diff for context-specific internal identifiers.
- kap-server's `/api/v1/debug/*` reflection RPC surface makes every DI Service callable; it is mounted only behind `--debug-endpoints` on a loopback bind with bearer auth — never widen that exposure casually.
- Fork surfaces need the same care: kimi-hub is a single-shared-token gate (`--token` / `KIMI_HUB_TOKEN`), and `--dangerous-bypass-auth` on `kimi web` / `kimi-hub` removes every auth and Host-origin check — never make bypass the default, never log the token, and keep the loopback/TLS-proxy deployment advice in `apps/kimi-hub/AGENTS.md` followed. The command bridge (`POST :command`) executes the host TUI's slash commands remotely; treat new commands there as remote-executable surface.

## Where to Update Instructions

- Hard rules that affect almost every task: update this root `AGENTS.md`.
- Rules that only affect a specific directory: update the nearest sub-directory `AGENTS.md` (`apps/kimi-hub/AGENTS.md` and `packages/kap-server/AGENTS.md` hold the fork's hub / command-bridge rules).
- Project-map entries stay at 1–2 sentences; deep package docs live in the package's own `AGENTS.md`.
- README's fork header ("What this fork adds", install path, typical setup) is fork-authored — keep it in sync when the remote-control delta changes.

## Workflow Requirements

- Prefer `rg` / `rg --files` when reading code.
- When designing changes, follow existing boundaries and local patterns first.
- When creating a PR, the PR title must follow Conventional Commit style, e.g. `chore: remove legacy format commands`.
- When an AI agent opens or updates a PR, fill in `.github/pull_request_template.md` — link the related issue or explain the problem, then describe what changed. Do not leave placeholder text or submit a generic summary of the diff.
- Do not submit vague AI-generated PR text. The human author must understand the change well enough to explain the code, edge cases, and why the approach fits this repository.
- Do not commit throwaway scratch or exploratory files. Never stage:
  - Agent working notes or handoff/summary documents (e.g. `HANDOVER-*.md`, `HANDOFF-*.md`, `handoff.md`).
  - Throwaway UI/UX prototypes or design mockups (e.g. `*-designs.html`, `*-mockup.html`, `*-demo(s).html`) at the repo root or under a `design/` folder. The only tracked `.html` files should be Vite `index.html` entrypoints.
  Before committing or opening a PR, run `git status` and `git diff --staged --stat` and remove anything matching these patterns. Put scratch work under `.tmp/` (gitignored) instead of the repo root or the source tree.
