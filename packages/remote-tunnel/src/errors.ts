/** Failure modes surfaced by the hub registry / agent client. */
export type TunnelErrorCode =
  | 'agent_not_found'
  | 'timeout'
  | 'agent_disconnected'
  | 'oversize_body'
  | 'ws_open_failed';

/**
 * Typed tunnel failure. `code` is stable and machine-readable; `message` is
 * human context only.
 */
export class TunnelError extends Error {
  readonly code: TunnelErrorCode;

  constructor(code: TunnelErrorCode, message: string) {
    super(message);
    this.name = 'TunnelError';
    this.code = code;
  }
}
