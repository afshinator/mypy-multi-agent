/**
 * Non-transient empty-turn watchdog (issue #9). The supervisor is prompted once,
 * so an empty completion simply ends its turn and idles the run. RT-10's transient
 * provider blip is covered by agent-level retries; this covers the rest by
 * re-prompting, bounded — the same policy as the peer path
 * (`runPromptWithRetry` in src/peer/peer-harness.ts).
 *
 * Pure: the extension decides when to call these, this module only decides whether
 * a turn is empty and whether the retry budget allows one more nudge.
 */

/** The re-prompt sent when the supervisor's turn ends with no text. */
export const EMPTY_TURN_NUDGE =
  "Your previous response was empty. Reply again with your full answer.";

/** How many re-prompts one empty-turn episode may use before the watchdog gives up. */
export const MAX_EMPTY_TURN_RETRIES = 3;

/**
 * The nudge to send back into the supervisor's turn, or undefined to let it settle.
 * Empty text is the only signal; a non-empty reply and an exhausted budget both
 * settle, which is what keeps the continuation loop bounded.
 */
export function nextEmptyTurnPrompt(
  lastAssistantText: string,
  nudgesSoFar: number,
  maxRetries: number = MAX_EMPTY_TURN_RETRIES,
): string | undefined {
  if (lastAssistantText.trim() !== "") return undefined;
  if (nudgesSoFar >= maxRetries) return undefined;
  return EMPTY_TURN_NUDGE;
}

/** The text of the last assistant message in the transcript; empty when there is none. */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const content = record.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null) return "";
        const block = part as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  return "";
}
