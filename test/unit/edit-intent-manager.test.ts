import { describe, expect, it, vi } from "vitest";
import { EditIntentManager } from "../../src/locks/edit-intent-manager";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";

describe("EditIntentManager", () => {
  it("announces intent before mutation", () => {
    const emit = vi.fn();
    const m = new EditIntentManager(emit);
    m.announce("a1", "src/a.ts", "fix bug");
    expect(emit).toHaveBeenCalledOnce();
    const env = emit.mock.calls[0]![0] as A2AEnvelope;
    expect(env.type).toBe("INTENT_TO_MODIFY");
    expect(env.sender).toBe("a1");
    expect(env.payload).toMatchObject({ agentId: "a1", filePath: "src/a.ts", intent: "fix bug" });
  });
});
