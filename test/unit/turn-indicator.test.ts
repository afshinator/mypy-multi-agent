/**
 * Unit tests for the pure, clock-injected turn-progress indicator: the age
 * bucket throttle, the WORKING→STALLED transition, and the progress reset.
 */
import { describe, expect, it } from "vitest";
import { TurnIndicator } from "../../src/peer/turn-indicator";

const NOW = 1_000_000;
const STALL = 30_000;

describe("TurnIndicator", () => {
  it("emits WORKING with a zero age at turn start", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    expect(t.view(true, NOW, STALL)).toEqual({
      state: "WORKING",
      displayState: "WORKING",
      progress: "0s",
    });
  });

  it("does not redraw within the same age bucket and display state", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    expect(t.view(true, NOW, STALL)).toBeDefined();
    expect(t.view(true, NOW + 14_000, STALL)).toBeUndefined();
    expect(t.view(true, NOW + 14_999, STALL)).toBeUndefined();
  });

  it("redraws when the age bucket advances", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    t.view(true, NOW, STALL);
    expect(t.view(true, NOW + 15_000, STALL)).toEqual({
      state: "WORKING",
      displayState: "WORKING",
      progress: "15s",
    });
  });

  it("emits STALLED at and above the stall threshold", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    t.view(true, NOW, STALL);
    expect(t.view(true, NOW + 30_000, STALL)).toEqual({
      state: "WORKING",
      displayState: "STALLED",
      progress: "30s",
    });
    expect(t.view(true, NOW + 45_000, STALL)).toEqual({
      state: "WORKING",
      displayState: "STALLED",
      progress: "45s",
    });
  });

  it("returns to WORKING when progress resumes", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    t.view(true, NOW, STALL);
    t.view(true, NOW + 30_000, STALL);
    t.observe(true, NOW + 31_000);
    expect(t.view(true, NOW + 31_000, STALL)).toEqual({
      state: "WORKING",
      displayState: "WORKING",
      progress: "0s",
    });
  });

  it("does not redraw when observe reports no progress", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    t.view(true, NOW, STALL);
    t.observe(false, NOW + 5_000);
    expect(t.view(true, NOW + 5_000, STALL)).toBeUndefined();
  });

  it("stallTimeoutMs 0 disables the STALLED state", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    t.view(true, NOW, 0);
    expect(t.view(true, NOW + 120_000, 0)?.displayState).toBe("WORKING");
  });

  it("emits nothing while no turn is open", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    expect(t.view(false, NOW + 120_000, STALL)).toBeUndefined();
  });

  it("reset forces the next view even inside the previous bucket", () => {
    const t = new TurnIndicator(NOW);
    t.reset(NOW);
    t.view(true, NOW, STALL);
    t.reset(NOW + 5_000);
    expect(t.view(true, NOW + 5_000, STALL)).toEqual({
      state: "WORKING",
      displayState: "WORKING",
      progress: "0s",
    });
  });
});
