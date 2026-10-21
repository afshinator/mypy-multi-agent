import { describe, expect, it } from "vitest";
import { parseSessionConfig, type SessionConfig } from "../../src/contracts/session-schema";
import { checkSessionConfig } from "../../src/scorecard/advisories";

const priced = () => false;

const STRONG_DOD = [
  "buildScorecard is pure and fixture-tested",
  "session.record_scorecard defaults to true",
  "run-details/scorecard.json is written and parses",
];

function cfg(
  opts: { dod?: string[]; agents?: { id: string; model: string }[] } = {},
): SessionConfig {
  const agents = (
    opts.agents ?? [
      { id: "impl", model: "p/author" },
      { id: "ver", model: "p/verify" },
      { id: "rev", model: "p/review" },
    ]
  ).map((a) => ({
    id: a.id,
    title: a.id,
    model: a.model,
    permissions: { read: true, edit: false, shell: false },
    max_cost_usd: 1,
    system_prompt: "sp",
  }));
  return parseSessionConfig(
    {
      version: "1.2",
      session: { id: "s", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "rev" },
      ask: { title: "t", description: "d", definition_of_done: opts.dod ?? STRONG_DOD },
      agents,
    },
    priced,
  );
}

describe("checkSessionConfig", () => {
  it("a strong config yields no advisories", () => {
    expect(checkSessionConfig(cfg())).toEqual([]);
  });

  it("M4 when the DoD has too few criteria", () => {
    expect(
      checkSessionConfig(cfg({ dod: ["bun run test passes", "typecheck is clean"] })).some(
        (a) => a.class === "M4",
      ),
    ).toBe(true);
  });

  it("M4 when a criterion is short or vague", () => {
    const a = checkSessionConfig(
      cfg({
        dod: [
          "The feature is implemented appropriately and robustly",
          "A file is created at docs/x.md",
          "bun run test passes with zero failures",
        ],
      }),
    );
    expect(a.some((x) => x.class === "M4")).toBe(true);
  });

  it("M5 on a shared model slug", () => {
    const a = checkSessionConfig(
      cfg({
        agents: [
          { id: "impl", model: "p/m" },
          { id: "ver", model: "p/m" },
          { id: "rev", model: "p/r" },
        ],
      }),
    );
    expect(a.some((x) => x.class === "M5" && x.detail.includes("shared"))).toBe(true);
  });

  it("M5 when every agent shares one model", () => {
    const a = checkSessionConfig(
      cfg({
        agents: [
          { id: "impl", model: "p/m" },
          { id: "ver", model: "p/m" },
          { id: "rev", model: "p/m" },
        ],
      }),
    );
    expect(a.some((x) => x.class === "M5" && x.detail.includes("no diversity"))).toBe(true);
  });

  it("advisories never throw and are warnings (structurally inert)", () => {
    const a = checkSessionConfig(cfg({ dod: ["x"] }));
    expect(Array.isArray(a)).toBe(true);
  });
});
