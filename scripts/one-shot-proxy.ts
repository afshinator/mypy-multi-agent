/**
 * Pure parts of the one-shot failure shim (issue #5), kept out of
 * `fault-inject.ts` so they can be tested without spawning a peer.
 */

/** True exactly once per shim: the first chat-completion call must fail. */
export function failFirstChat(isChat: boolean, chatCalls: number): boolean {
  return isChat && chatCalls === 1;
}

/** Response headers a proxy must not copy verbatim; Node re-frames the body. */
const HOP_HEADERS = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
] as const;

export function stripHopHeaders<T extends Record<string, unknown>>(headers: T): Partial<T> {
  const kept = { ...headers };
  for (const name of HOP_HEADERS) delete kept[name];
  return kept;
}
