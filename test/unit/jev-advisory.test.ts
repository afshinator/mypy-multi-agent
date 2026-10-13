/**
 * Unit tests for the Jev advisory glue in src/pi/extension.ts. No network: the
 * model registry and classifier are fakes.
 */

import { describe, expect, it } from "vitest";
import type { CriterionVerdict } from "../../src/contracts/criteria";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { jevAdvisory } from "../../src/pi/extension";

const verdict = (criterion: string, evidence = "verified evidence"): CriterionVerdict => ({
  criterion,
  evidence,
  result: "pass",
});

const config = (jev: unknown) =>
  parseSessionConfig({
    version: "1.1",
    session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, jev, attester: "a" },
    ask: { title: "t", description: "d", definition_of_done: ["c1"] },
    agents: [
      {
        id: "a",
        title: "A",
        model: "m/m",
        permissions: { read: true, edit: false, shell: false },
        max_cost_usd: 1,
        system_prompt: "sp",
      },
    ],
  });

describe("jevAdvisory", () => {
  it("returns undefined when verdict_check is false", async () => {
    const ctx = { modelRegistry: {}, ui: { notify() {} } } as unknown as Parameters<
      typeof jevAdvisory
    >[0];
    await expect(
      jevAdvisory(ctx, config({ verdict_check: false }), [verdict("c1")]),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the model lookup misses", async () => {
    const ctx = {
      modelRegistry: { getModelOfType: () => undefined },
      ui: { notify() {} },
    } as unknown as Parameters<typeof jevAdvisory>[0];
    await expect(
      jevAdvisory(ctx, config({ verdict_check: true, model: "openrouter/nope" }), [verdict("c1")]),
    ).resolves.toBeUndefined();
  });

  it("flags a weak estimate through estimate -> judgeVerdicts -> VerdictAdvisory", async () => {
    const seen: unknown[] = [];
    const ctx = {
      modelRegistry: {
        getModelOfType: () => ({
          provider: "openrouter",
          id: "typesafe/jev-1.13",
          api: "typesafe-system-one",
        }),
        classify: async (_model: unknown, context: unknown) => {
          seen.push(context);
          return {
            stopReason: "stop",
            answers: { establishes: { type: "bool", probability: 0.2 } },
          };
        },
      },
      ui: { notify() {} },
    } as unknown as Parameters<typeof jevAdvisory>[0];

    const advisory = await jevAdvisory(
      ctx,
      config({ verdict_check: true, model: "openrouter/typesafe/jev-1.13" }),
      [verdict("c1", "verified evidence")],
    );

    expect(advisory).toBeDefined();
    expect(advisory?.perCriterion[0]?.flagged).toBe(true);
    expect(advisory?.perCriterion[0]?.establishes).toBe(0.2);
    // The classify call was driven by the real EstablishesEstimate seam: the
    // verdict evidence reached the fake in the classifier state.
    expect(seen).toHaveLength(1);
    expect((seen[0] as { state: { evidence: string } }).state.evidence).toBe("verified evidence");
  });
});
