/**
 * Emits INTENT_TO_MODIFY before an authorized file mutation; the bus side feeds
 * ChangeDetector.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";

/** Emits INTENT_TO_MODIFY before an authorized file mutation. */
export class EditIntentManager {
  private seq = 0;

  constructor(private readonly emit: (env: A2AEnvelope) => void) {}

  announce(agentId: string, filePath: string, intent: string): void {
    const seq = ++this.seq;
    this.emit({
      id: `intent-${seq}`,
      timestamp: Date.now(),
      sender: agentId,
      recipient: "supervisor",
      type: "INTENT_TO_MODIFY",
      payload: { agentId, filePath, intent },
    });
  }
}
