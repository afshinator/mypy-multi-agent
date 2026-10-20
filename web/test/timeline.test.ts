import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTimeline } from "../lib/timeline";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const text = fixture("conversation-trimmed.jsonl");

describe("buildTimeline", () => {
  it("parses events chronologically and collects actors and types", () => {
    const timeline = buildTimeline(text);
    const timestamps = timeline.events.map((e) => e.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(timeline.events.length).toBeGreaterThan(10);
    expect(timeline.types).toContain("WORK_ORDER");
    expect(timeline.types).toContain("RETRY");
    expect(timeline.actors).toEqual(["implementer", "reviewer", "test_verifier"]);
  });

  it("flags opens and closes by event type", () => {
    const timeline = buildTimeline(text);
    const prompt = timeline.events.find((e) => e.id === "prompt-1");
    expect(prompt?.isOpen).toBe(true);
    expect(prompt?.isClose).toBe(false);
    const report = timeline.events.find((e) => e.id === "report-implementer-1792458327757");
    expect(report?.isOpen).toBe(false);
    expect(report?.isClose).toBe(true);
  });

  it("computes per-agent durations via shared turnDurations identity pairing", () => {
    const timeline = buildTimeline(text);
    // test_verifier responded first (1792457997233), but prompt-1 belongs to
    // implementer: identity pairing gives 1931ms, not a timestamp-zip's 1508ms.
    expect(timeline.durationsByAgent).toEqual({
      implementer: [1931, 286773],
      test_verifier: [1508, 38748],
    });
  });
});
