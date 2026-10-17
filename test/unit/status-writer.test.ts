/**
 * Unit tests for the peer status writer module.
 */
import { describe, expect, it } from "vitest";
import type { StatusAdapter } from "../../src/herdr/status-adapter";
import { writePeerStatus } from "../../src/peer/status-writer";

describe("writePeerStatus", () => {
  it("does not raise an unhandled rejection when the status write fails", async () => {
    let calls = 0;
    const status = {
      setStatus: () => {
        calls++;
        return Promise.reject(new Error("pane gone"));
      },
    } as unknown as StatusAdapter;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      writePeerStatus(
        status,
        "p1",
        { agentId: "a", title: "A", model: "m/m" },
        "WORKING",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(calls).toBe(1);
  });
});
