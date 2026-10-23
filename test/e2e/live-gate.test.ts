/**
 * Unit tests for the end-to-end run gate. The e2e suite performs a real run
 * (panes + model spend), so it must never switch itself on because of ambient
 * environment: peers run inside herdr panes, inherit HERDR_ENV=1, and a peer
 * that runs `bun run test` would otherwise nest a live run inside a live run.
 */
import { describe, expect, it } from "vitest";
import { e2eEnabled } from "./live-gate";

describe("e2eEnabled", () => {
  it("is off with an empty environment", () => {
    expect(e2eEnabled({})).toBe(false);
  });

  it("stays off inside a herdr pane", () => {
    expect(e2eEnabled({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" })).toBe(false);
  });

  it("is on only with an explicit E2E_LIVE=1", () => {
    expect(e2eEnabled({ E2E_LIVE: "1" })).toBe(true);
  });

  it("is on when both are set", () => {
    expect(e2eEnabled({ HERDR_ENV: "1", E2E_LIVE: "1" })).toBe(true);
  });

  it("treats any other E2E_LIVE value as off", () => {
    expect(e2eEnabled({ E2E_LIVE: "0" })).toBe(false);
    expect(e2eEnabled({ E2E_LIVE: "true" })).toBe(false);
  });
});
