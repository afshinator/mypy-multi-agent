/**
 * M1 of the C2 injection gate: the three additive `session.jev` keys. `JevSchema`
 * is a strictObject, so a config that sets them is rejected with
 * `unrecognized_keys` until the delta lands (data-contracts.md §2, amendment A6).
 */
import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const config = (jev: Record<string, unknown>) =>
  parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, jev, attester: "a" },
    ask: { title: "t", description: "d", definition_of_done: ["dod"] },
    agents: [
      {
        id: "a",
        title: "A",
        model: "provider/model",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1,
        system_prompt: "sp",
      },
    ],
  });

const jev = (raw: Record<string, unknown>) => config(raw).session.jev;

describe("session.jev injection gate keys", () => {
  it("omitting all three parses and defaults to off / 0.8 / 2000", () => {
    expect(jev({})).toMatchObject({
      injection_check: false,
      injection_threshold: 0.8,
      injection_timeout_ms: 2000,
    });
    expect(jev({ verdict_check: true })).toMatchObject({
      injection_check: false,
      injection_threshold: 0.8,
      injection_timeout_ms: 2000,
    });
  });

  it("setting all three parses", () => {
    expect(
      jev({ injection_check: true, injection_threshold: 0.9, injection_timeout_ms: 500 }),
    ).toMatchObject({
      injection_check: true,
      injection_threshold: 0.9,
      injection_timeout_ms: 500,
    });
  });

  it("injection_timeout_ms: 0 is valid and disables the bound", () => {
    expect(jev({ injection_timeout_ms: 0 })?.injection_timeout_ms).toBe(0);
    expect(() => config({ injection_timeout_ms: -1 })).toThrow();
    expect(() => config({ injection_timeout_ms: 1.5 })).toThrow();
  });

  it("injection_threshold outside the open interval (0,1) is rejected", () => {
    for (const bad of [0, 1, 1.5, -0.2]) {
      expect(() => config({ injection_threshold: bad })).toThrow();
    }
  });

  it("injection_check is a boolean and the existing keys are unchanged", () => {
    expect(() => config({ injection_check: "yes" })).toThrow();
    expect(jev({})).toMatchObject({
      verdict_check: false,
      model: "openrouter/typesafe/jev-1.13",
      review_threshold: 0.5,
    });
  });
});
