/**
 * Live classifier smoke test: resolves the Jev slug and issues one real
 * classify call. Gated on JEV_LIVE=1 because it costs money and needs network.
 */

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const live = process.env.JEV_LIVE === "1" ? it : it.skip;

describe("jev live classifier", () => {
  live("resolves and classifies openrouter/typesafe/jev-1.13", async () => {
    const registry = new ModelRegistry(await ModelRuntime.create());
    const model = registry.getModelOfType("classifier", "openrouter", "typesafe/jev-1.13");
    expect(model).toBeDefined();
    if (!model) throw new Error("jev model not resolved");
    const r = await registry.classify(model, {
      state: { criterion: "c1", evidence: "verified evidence" },
      questions: {
        establishes: {
          type: "bool",
          instructions:
            "Does the evidence actually establish the criterion, or does it only restate the criterion or prove something else?",
          criteria: {
            true: "The evidence is a concrete observation that proves the criterion",
            false: "The evidence restates the criterion, is missing, or proves something else",
          },
        },
      },
    });
    const establishes = r.answers.establishes;
    console.log(`jev model: ${model.provider}/${model.id}`);
    expect(r.stopReason).toBe("stop");
    expect(establishes?.type).toBe("bool");
    if (establishes?.type === "bool") {
      console.log(`jev probability: ${establishes.probability}`);
      expect(typeof establishes.probability).toBe("number");
    }
  });
});
