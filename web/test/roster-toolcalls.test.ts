import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPeerRoster } from "../lib/roster";
import { buildToolCalls } from "../lib/tool-calls";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("buildToolCalls", () => {
  it("parses tool-calls.jsonl into chronological typed slices", () => {
    const calls = buildToolCalls(fixture("tool-calls-trimmed.jsonl"));
    expect(calls).toHaveLength(4);
    const timestamps = calls.map((c) => c.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(calls[0]?.toolName).toBe("ls");
  });

  it("keeps args as JSON, flags errors, and tolerates a missing durationMs", () => {
    const calls = buildToolCalls(fixture("tool-calls-trimmed.jsonl"));
    const edit = calls.find((c) => c.toolName === "edit");
    expect(edit?.isError).toBe(true);
    expect(edit?.argsText).toBe('{"edits":[{"newText":"x"}]}');
    expect(edit?.durationMs).toBe(1200);
    const bash = calls.find((c) => c.toolName === "bash");
    expect(bash?.isError).toBe(false);
    expect(bash?.durationMs).toBeUndefined();
  });
});

describe("buildPeerRoster", () => {
  it("aggregates run-state agents into roster entries", () => {
    const roster = buildPeerRoster(fixture("run-state-roster.json"));
    expect(roster.peers).toHaveLength(2);
    const implementer = roster.peers[0];
    expect(implementer?.id).toBe("implementer");
    expect(implementer?.state).toBe("DONE");
    expect(implementer?.usageCostUsd).toBeCloseTo(0.20042668800000002);
    expect(implementer?.usageTokens).toBe(1771470);
    expect(implementer?.maxCostUsd).toBe(3);
    expect(implementer?.maxTokens).toBeUndefined();
    expect(implementer?.lastCompletedWorkOrder).toBe("task-1");
  });

  it("keeps maxTokens when present", () => {
    const roster = buildPeerRoster(fixture("run-state-roster.json"));
    const verifier = roster.peers[1];
    expect(verifier?.id).toBe("test_verifier");
    expect(verifier?.maxCostUsd).toBe(0.6);
    expect(verifier?.maxTokens).toBe(400000);
    expect(verifier?.usageTokens).toBe(295015);
  });
});
