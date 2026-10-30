/**
 * Issue #134: the first-tool-call probe's decision seam. The verdict comes from
 * tool-call activity alone — a reply is never evidence — so a live but silent
 * peer is never written off, and a mute slug is never handed a writer role.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_TOOL_CALL_PROBE_WINDOW_MS,
  firstToolCallProbe,
  writerRoleNeedsProbe,
  writerRoleProbeEligible,
} from "../../src/runtime/first-tool-call-probe";

const free = (m: string) => m.startsWith("free/");

describe("firstToolCallProbe", () => {
  it("the shipped probe window is 30 s", () => {
    expect(FIRST_TOOL_CALL_PROBE_WINDOW_MS).toBe(30000);
  });

  it("proceeds on observed tool calls with no reply: a silent peer that is tooling is proven (#134 DoD: no reply, two tool calls inside the window)", () => {
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 2,
        replied: false,
        elapsedMs: 5000,
        windowMs: 30000,
      }),
    ).toEqual({ action: "proceed", reason: "tool call observed" });
  });

  it("proceeds on a progress report before the first tool call finishes: a slow first call is activity, not silence", () => {
    expect(
      firstToolCallProbe({
        toolCalls: 0,
        progressed: true,
        replied: false,
        elapsedMs: 6000,
        windowMs: 30000,
      }),
    ).toEqual({ action: "proceed", reason: "progress observed" });
  });

  it("a reply without a tool call is not proof: wait, then unproven at the window", () => {
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 0,
        replied: true,
        elapsedMs: 5000,
        windowMs: 30000,
      }).action,
    ).toBe("wait");
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 0,
        replied: true,
        elapsedMs: 30000,
        windowMs: 30000,
      }).action,
    ).toBe("unproven");
  });

  it("slow to start but alive: the first tool call inside the window lets the assignment proceed", () => {
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 0,
        replied: false,
        elapsedMs: 25000,
        windowMs: 30000,
      }).action,
    ).toBe("wait");
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 1,
        replied: false,
        elapsedMs: 29000,
        windowMs: 30000,
      }).action,
    ).toBe("proceed");
  });

  it("no tool call by the window's end reports the slug unproven", () => {
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 0,
        replied: false,
        elapsedMs: 30000,
        windowMs: 30000,
      }),
    ).toEqual({ action: "unproven", reason: "no tool activity within the probe window" });
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 0,
        replied: false,
        elapsedMs: 60000,
        windowMs: 30000,
      }).action,
    ).toBe("unproven");
  });

  it("a tool call observed is proven even after the window has passed: a live peer is never reported unproven on timing alone", () => {
    expect(
      firstToolCallProbe({
        progressed: false,
        toolCalls: 1,
        replied: false,
        elapsedMs: 60000,
        windowMs: 30000,
      }).action,
    ).toBe("proceed");
  });
});

describe("writerRoleNeedsProbe (arming)", () => {
  const writer = { model: "free/x", edit: true };
  const order = (writeScope?: string[]) => ({
    ...(writeScope === undefined ? {} : { writeScope }),
  });

  it("arms for a free-class writer role on a slug with no observed tool call", () => {
    expect(writerRoleNeedsProbe(writer, order(["src/a.ts"]), 0, free)).toBe(true);
  });

  it("does not arm once a tool call has been observed", () => {
    expect(writerRoleNeedsProbe(writer, order(["src/a.ts"]), 1, free)).toBe(false);
  });

  it("does not arm for a priced slug, a read-only peer, or an order with no writeScope", () => {
    expect(writerRoleNeedsProbe({ model: "paid/y", edit: true }, order(["a.ts"]), 0, free)).toBe(
      false,
    );
    expect(writerRoleNeedsProbe({ model: "free/x", edit: false }, order(["a.ts"]), 0, free)).toBe(
      false,
    );
    expect(writerRoleNeedsProbe(writer, order(), 0, free)).toBe(false);
    expect(writerRoleProbeEligible(writer, order(["a.ts"]), free)).toBe(true);
    expect(writerRoleProbeEligible(writer, order(), free)).toBe(false);
  });
});
