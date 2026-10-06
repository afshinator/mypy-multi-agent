import { describe, expect, it } from "vitest";
import { SessionState } from "../../src/control/session-state";

describe("SessionState", () => {
  it("starts ACTIVE", () => {
    expect(new SessionState().current).toBe("ACTIVE");
  });

  it("enters FINALIZING", () => {
    const s = new SessionState();
    s.enterFinalizing();
    expect(s.isFinalizing).toBe(true);
    expect(s.current).toBe("FINALIZING");
  });

  it("enterFinalizing is idempotent", () => {
    const s = new SessionState();
    s.enterFinalizing();
    s.enterFinalizing();
    expect(s.current).toBe("FINALIZING");
  });

  it("rejects new work during FINALIZING", () => {
    const s = new SessionState();
    expect(s.acceptsNewWork()).toBe(true);
    s.enterFinalizing();
    expect(s.acceptsNewWork()).toBe(false);
  });

  it("blocks reactivation during FINALIZING", () => {
    const s = new SessionState();
    expect(s.canReactivate()).toBe(true);
    s.enterFinalizing();
    expect(s.canReactivate()).toBe(false);
  });

  it("completes from FINALIZING", () => {
    const s = new SessionState();
    s.enterFinalizing();
    s.complete();
    expect(s.current).toBe("COMPLETE");
  });

  it("aborts from ACTIVE", () => {
    const s = new SessionState();
    s.abort();
    expect(s.current).toBe("ABORTED");
  });

  it("cannot complete without FINALIZING", () => {
    const s = new SessionState();
    expect(() => s.complete()).toThrow();
  });
});
