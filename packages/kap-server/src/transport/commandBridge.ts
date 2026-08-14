/**
 * The optional slash-command bridge an embedding host injects into
 * `startServer({ commandBridge })`.
 *
 * The grammar for `/…` composer commands is the HOST's asset, not the
 * server's: the TUI owns the full registry + dispatch, and there is no second
 * implementation of it anywhere in this package. When a host (today: the TUI
 * behind `/remote connect`) embeds kap-server in-process, it hands the routes
 * a bridge so remote clients (the hub web UI) can run the host's commands
 * verbatim over `POST /sessions/{id}:command` and enumerate them over
 * `GET /sessions/{id}/commands` for composer hints. A server started without
 * a bridge (`kimi web`, headless `kimi remote connect`) answers the action
 * with `40421 command.unavailable` and an empty catalog.
 */

/** One catalog row for composer autocomplete (mirrors the host's registry entry). */
export interface SessionCommandInfo {
  readonly name: string;
  readonly aliases: readonly string[];
  /** One-line grammar, e.g. `/goal <objective>`. */
  readonly usage: string;
  readonly description?: string;
}

/** The lines a command produced, split the way the host split them. */
export interface SessionCommandResult {
  readonly notices: readonly string[];
  readonly errors: readonly string[];
}

export interface SessionCommandBridge {
  /** The commands the host currently offers (static builtins + dynamic skills/plugins). */
  catalog(): readonly SessionCommandInfo[];
  /**
   * Run one composer line (`/yolo on`, `/compact focus on tests`, …) against
   * the given session and report the lines the host surfaced for it. The
   * bridge — not the route — owns every policy decision: unknown words,
   * busy-gating, wrong-session rejection, and how interactive (picker-bound)
   * commands degrade.
   */
  execute(sessionId: string, input: string): Promise<SessionCommandResult>;
}
