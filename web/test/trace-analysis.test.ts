import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../shared/parse-jsonl";
import { buildSpanTrace } from "../lib/spans";
import {
  agentIdleTime,
  criticalPath,
  parallelismFactor,
  supervisorLatency,
} from "../lib/trace-analysis";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const spans = buildSpanTrace(fixture("spans-trimmed.jsonl")).spans;
const conversation = parseJsonl(fixture("conversation-trimmed.jsonl"));

describe("criticalPath", () => {
  it("returns the longest root->leaf chain with summed duration", () => {
    expect(criticalPath(spans)).toEqual({
      spanIds: ["root1", "prompt1", "turn1", "tool1"],
      durationMs: 14900,
    });
  });

  it("returns null when spans are empty", () => {
    expect(criticalPath([])).toBeNull();
  });
});

describe("parallelismFactor", () => {
  it("divides total span duration by wall clock", () => {
    expect(parallelismFactor(spans)).toBeCloseTo(17000 / 9000);
  });

  it("returns null when spans are empty", () => {
    expect(parallelismFactor([])).toBeNull();
  });
});

describe("agentIdleTime", () => {
  it("computes per-agent wall, active, and idle time", () => {
    expect(agentIdleTime(spans, conversation)).toEqual({
      implementer: { wallMs: 332037, activeMs: 3000, idleMs: 329037 },
    });
  });
});

describe("supervisorLatency", () => {
  it("returns gaps between each FINAL_REPORT and the next WORK_ORDER", () => {
    expect(supervisorLatency(conversation)).toEqual([15981]);
  });

  it("returns an empty array when there is no FINAL_REPORT followed by a WORK_ORDER", () => {
    expect(supervisorLatency([])).toEqual([]);
  });
});
