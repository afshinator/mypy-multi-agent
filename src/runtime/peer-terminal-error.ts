/**
 * Rejection raised when a request targets a peer that is already STOPPED or
 * CRASHED (or when such a peer terminates with a request in flight). Runtime
 * keys its run-log event on `name`, so this must not be a plain Error.
 */
export class PeerTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerTerminalError";
  }
}
