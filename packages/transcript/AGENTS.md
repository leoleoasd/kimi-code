# transcript Agent Guide

The isomorphic transcript rendering data layer — agent-granular L1 store, idempotent L2 operations, `off/turn/block/delta` L3 subscription granularity, framework-free L4 view registry, and turn-cursor pagination. Pure TypeScript (browser-safe, no engine imports) and the sole owner of all transcript contract types (`src/contract/`); consumed by `packages/kap-server` (engine events → transcript, REST + WS surface; live stores backfill history from the persisted per-agent wire records — main on first attach, any agent on demand, cold sessions rebuild any agent — with 0-based turn ordinals and per-turn step ids both pinned to the engine's numbering, a contentless failed attempt leaving a hole in the cold fold's step sequence so the live/heal merge by stepId+frameId stays aligned).

## Comment conventions

No comments — no file headers, no section banners, no statement-level narration; the code is the source of truth. The only exception is JSDoc attached to exported symbols (it flows into the generated `.d.ts` and IDE hover). Lint-suppression directives (`oxlint-disable` / `eslint-disable`) are allowed where they suppress an active rule for a deliberate pattern; other tooling directives (`@ts-expect-error`, `@ts-ignore`, …) stay banned — fix the underlying type problem instead. Enforced by `scripts/check-no-comments.mjs` (part of `pnpm lint`).

## Cold rebuild

The cold rebuild is a two-level fold over `wire.jsonl` as the single source of truth: `history/groupTurns.ts` (context messages → turn tree) plus `history/foldFacts.ts` (non-context records → tasks, interactions, todos, goal/plan/swarm meta, and end-appended markers/taskrefs; interactions left pending at shutdown fold to `cancelled`). Media on a turn-opening user message folds into attachment entities from BOTH persisted vocabularies — the legacy v1 `image`/`video`/`file` + `source` shapes (keeping their `url`/`file` sources) and the v2 core `image_url`/`video_url` parts (camelCase inner keys): `data:`/`http(s)` → `url`, `blobref:<mime>;<sha256>` → the `blob` source (`ref` = the full blobref string; bytes live in the agent-scoped blob store, served by kap-server's blob route), and `kimi-file://<fileId>` urls fall through to the daemon file ref (`contract/mediaRef.ts`) → the `session_media` source. All url classification is pure string ops — the package never imports the engine.

## User-message classification

`history/userText.ts` (`classifyUserText`) is applied to every user-role text — cold fold and kap-server's live projection alike: a `[kimi-hub message from <from>]` envelope becomes a `hub` frame (envelope header + disclaimer stripped, `from` carried on `TextFrame.hubFrom` and merged into the turn origin payload); text that reduces to nothing after peeling `<system-reminder>` / skill-loaded harness envelopes is `internal` and never reaches the transcript (attachments on such a message still fold); anything else is a plain `user` bubble with the envelopes peeled. No new frame kind — older consumers that don't know `hubFrom` degrade to a regular user card.

## Plan content

Plan content is a recorded fact too: each ExitPlanMode review submission offloads the document to `agents/<agentId>/plan/<planId>/v<N>.md` and persists a reference-only `plan.revision` record (`{id, version, path, sha256, bytes}`), which projects — live and cold — to a `plan.revision` marker and the `modes.plan` badge (`{reviewPath, version}`).

## Op-batch sequencing contract

Owned here (`transcriptSeqSchema` in `contract/schema.ts`): a per-(session, agent) monotonic batch `seq` on `transcript.ops` / `transcript.reset` / the REST transcript response, the `transcript_since` subscription cursor, and the `GET .../transcript/ops` catch-up response shape — every field optional so pre-seq peers fall back to loss-signal-driven refreshes.

## Wire-level detail

Beyond the timeline, the model carries wire-equivalent detail: steps carry `usage` / `finishReason` / `timing` (LLM latencies) / `retry` / interrupt reason, turns carry `durationMs` / `error` / `usage`, tool frames carry the streamed `inputText` and the latest `progress`, tasks carry subagent `resultSummary` / `error` / `stateReason` / `usage`, `meta.agent` mirrors the agent status slices (model / usage / context / permission / phase), a global `prompts` entity (op `prompt.upsert`) tracks the prompt queue, and `hook.result` lands as a `'hook'` marker. These live-projected fields are NOT backfilled by the cold rebuild (known limitation).
