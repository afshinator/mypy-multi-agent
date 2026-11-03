/**
 * Turn liveness in one place: beat -> busy, progress -> restamp, idle -> clear,
 * timeout -> stalled, plus the deferred-stop latch. No socket, no bus.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

import { TurnState } from "../../src/runtime/turn-state";

const HEARTBEAT = 3000;

describe("busy and progress", () => {
  it("is busy from the first busy beat and keeps the clock on a later bare beat", () => {
    const t = new TurnState(HEARTBEAT);
    t.progress("a", 100);
    expect(t.isBusy("a")).toBe(true);
    expect(t.progressAt("a")).toBe(100);
    t.progress("a", 900);
    expect(t.progressAt("a")).toBe(100);
  });

  it("restamps on a progress tick and records the tick separately", () => {
    const t = new TurnState(HEARTBEAT);
    t.progress("a", 100);
    t.progress("a", 900, true);
    expect(t.progressAt("a")).toBe(900);
    expect(t.lastTickAt("a")).toBe(900);
  });

  it("a heartbeat alone never opens a turn", () => {
    const t = new TurnState(HEARTBEAT);
    t.beat("a", 100);
    expect(t.isBusy("a")).toBe(false);
  });

  it("clears busy, the tick and the stalled flag when the turn ends", () => {
    const t = new TurnState(HEARTBEAT);
    t.progress("a", 100, true);
    t.markStalled("a");
    t.idle("a");
    expect(t.isBusy("a")).toBe(false);
    expect(t.lastTickAt("a")).toBeUndefined();
    expect(t.isStalled("a")).toBe(false);
  });
});

describe("heartbeat lapse", () => {
  it("reports a lapsed peer once and re-arms on the next beat", () => {
    const t = new TurnState(HEARTBEAT);
    t.beat("a", 0);
    expect(t.lapsed(HEARTBEAT - 1)).toEqual([]);
    expect(t.lapsed(HEARTBEAT)).toEqual(["a"]);
    expect(t.lapsed(HEARTBEAT + 1)).toEqual([]);
    t.beat("a", HEARTBEAT + 2);
    expect(t.lapsed(2 * HEARTBEAT + 2)).toEqual(["a"]);
  });

  it("forgets a peer so a reconnect is not judged by the old silence", () => {
    const t = new TurnState(HEARTBEAT);
    t.beat("a", 0);
    t.forget("a");
    expect(t.lapsed(HEARTBEAT)).toEqual([]);
  });
});

describe("stall scan", () => {
  it("returns the elapsed time of an overdue turn and nothing while it is flagged", () => {
    const t = new TurnState(HEARTBEAT);
    t.progress("a", 1000);
    expect(t.overdue(() => 500, 1400)).toEqual([]);
    expect(t.overdue(() => 500, 1600)).toEqual([{ agentId: "a", elapsedMs: 600 }]);
    t.markStalled("a");
    expect(t.overdue(() => 500, 9000)).toEqual([]);
  });

  it("skips a peer whose deadline is zero, and ignores idle peers", () => {
    const t = new TurnState(HEARTBEAT);
    t.progress("a", 0);
    t.progress("b", 0);
    t.idle("b");
    expect(t.overdue(() => 0, 10_000)).toEqual([]);
    expect(t.overdue((id) => (id === "a" ? 100 : 1000), 10_000)).toEqual([
      { agentId: "a", elapsedMs: 10_000 },
    ]);
  });

  it("records a progress tick as the stall clock, not merely being busy", () => {
    const t = new TurnState(HEARTBEAT);
    t.progress("a", 100);
    t.progress("a", 500, true);
    expect(t.overdue(() => 100, 700)).toEqual([{ agentId: "a", elapsedMs: 200 }]);
  });
});

describe("deferred stop latch", () => {
  it("defers once, is listed, and is taken exactly once", () => {
    const t = new TurnState(HEARTBEAT);
    t.deferStop("a");
    expect(t.deferredStops()).toEqual(["a"]);
    expect(t.takeDeferredStop("a")).toBe(true);
    expect(t.takeDeferredStop("a")).toBe(false);
    expect(t.deferredStops()).toEqual([]);
  });

  it("drops the latch when the peer is forgotten", () => {
    const t = new TurnState(HEARTBEAT);
    t.deferStop("a");
    t.forget("a");
    expect(t.deferredStops()).toEqual([]);
  });
});

describe("Runtime holds none of it", () => {
  it("declares no turn map and no heartbeat monitor", () => {
    const source = readFileSync(join(repoRoot, "src/runtime/runtime.ts"), "utf8");
    for (const gone of [
      "turnProgress",
      "lastProgressTick",
      "pendingStop",
      "HeartbeatMonitor",
      "heartbeats.",
    ]) {
      expect(source).not.toContain(gone);
    }
    expect(source).toContain("this.turns.");
  });
});
