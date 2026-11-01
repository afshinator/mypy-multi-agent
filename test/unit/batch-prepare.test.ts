import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BatchPolicy } from "../../src/batch/policy";
import { type PrepareDeps, prepare } from "../../src/batch/prepare";
import type { BatchRequest } from "../../src/batch/request";
import type { CommentRef, TicketSnapshot } from "../../src/batch/tracker";
import { parseSessionConfig } from "../../src/contracts/session-schema";

const REPO_ROOT = process.cwd();
const POLICY: BatchPolicy = {
  prepare: {
    kinds: ["code-fix"],
    kindTemplates: { "code-fix": "templates/batch-code-fix.yaml" },
    triageModel: "deepseek/deepseek-v4-pro",
    verifierModel: "openrouter/openai/gpt-6-luna",
    agentTimeoutMinutes: 5,
  },
  run: { timeoutMinutes: 5 },
};
const REQUEST: BatchRequest = { id: "b7", tickets: [42] };

const TRIAGE = `## Claim checks
| claim | command | observed | verdict |
| --- | --- | --- | --- |
| The gate folds backticks | \`sed -n '66,85p' src/supervisor/finalization.ts\` | fold() strips them | true |
| The helper is used once | \`rg -n "criteriaMismatches" src/\` | one hit | true |

## Need
The gate.

## Fix
Normalize first.

## Definition of Done
1. \`normalizeDoD\` strips a checkbox — proven by a unit test
2. A manifest survives serialization

## Verdict
\`run\`

## Open questions
none

KIND: code-fix
`;

const VERDICT_BLOCK = (...verdicts: ("match" | "mismatch")[]) =>
  `\`\`\`json\n[${verdicts
    .map((v, i) => `{"row":${i + 1},"verdict":"${v}","evidence":"seen"}`)
    .join(",")}]\n\`\`\`\n\ncould-not-run: none\n`;

interface Calls {
  comments: { ticket: number; marker: string; text: string }[];
  labels: { ticket: number; label: string }[];
  order: string[];
}

let cwd: string;
let calls: Calls;
let deps: PrepareDeps;
let ticket: TicketSnapshot;

function tracker() {
  return {
    view: async () => ticket,
    upsertMarkerComment: async (n: number, marker: string, text: string) => {
      calls.comments.push({ ticket: n, marker, text });
      calls.order.push("comment");
      return { action: "created" as const, id: 1 };
    },
    addLabel: async (n: number, label: string) => {
      calls.labels.push({ ticket: n, label });
      calls.order.push("label");
    },
    removeLabel: async () => {
      calls.order.push("removeLabel");
    },
  };
}

function depsWith(replies: string[]): PrepareDeps {
  let i = 0;
  return {
    cwd,
    repoRoot: REPO_ROOT,
    tracker: tracker(),
    agent: async () => ({ text: replies[i++] ?? "", costUsd: 0.01 }),
    preflight: async (slugs: string[]) => slugs.map((slug) => ({ slug, ok: true })),
    clone: { make: async () => cwd, remove: async () => {} },
  };
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mypi-prepare-"));
  calls = { comments: [], labels: [], order: [] };
  ticket = {
    number: 42,
    title: "A ticket",
    body: "",
    state: "OPEN",
    labels: [],
    updatedAt: "",
    comments: [] as CommentRef[],
  };
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("prepare — acceptance", () => {
  it("writes the manifest, then the comment, then the label", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, kind: "code-fix", slug: "b-b7-t42" });
    // Backticks stay: the gate folds them, and normalization only removes what it cannot.
    expect(outcome?.criteria).toEqual([
      "`normalizeDoD` strips a checkbox — proven by a unit test",
      "A manifest survives serialization",
    ]);

    const manifestPath = join(cwd, "mypi-tasks/b-b7-t42/session.yaml");
    const config = parseSessionConfig(parse(readFileSync(manifestPath, "utf8")), () => false);
    expect(config.session.id).toBe("b-b7-t42");
    expect(config.ask.definition_of_done).toEqual(outcome?.criteria);

    expect(calls.order).toEqual(["comment", "label"]);
    expect(calls.labels).toEqual([{ ticket: 42, label: "ready-for-agent" }]);
    expect(calls.comments[0]?.marker).toBe("<!-- mypi-batch:b7:42 -->");
    expect(calls.comments[0]?.text).toContain(
      "- `normalizeDoD` strips a checkbox — proven by a unit test",
    );
  });

  it("writes a comment but no manifest and no label for KIND: inline", async () => {
    deps = depsWith([
      TRIAGE.replace("KIND: code-fix", "KIND: inline"),
      VERDICT_BLOCK("match", "match"),
    ]);
    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, kind: "inline" });
    expect(calls.order).toEqual(["comment"]);
    expect(existsSync(join(cwd, "mypi-tasks/b-b7-t42"))).toBe(false);
  });

  it("does not run or verify when the ticket is already closed", async () => {
    ticket = { ...ticket, state: "CLOSED" };
    let agentCalls = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        agentCalls += 1;
        return { text: "", costUsd: 0 };
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "not-needed" });
    expect(agentCalls).toBe(0);
    expect(calls.labels).toEqual([]);
  });
});

describe("prepare — refusals keep the label off", () => {
  const cases: [string, string[], string][] = [
    ["a verifier mismatch", [TRIAGE, VERDICT_BLOCK("match", "mismatch")], "verifier-mismatch"],
    [
      "a missing KIND line",
      [TRIAGE.replace("KIND: code-fix", ""), VERDICT_BLOCK("match", "match")],
      "kind-invalid",
    ],
    [
      "an unknown KIND",
      [TRIAGE.replace("KIND: code-fix", "KIND: nope"), VERDICT_BLOCK("match", "match")],
      "kind-invalid",
    ],
    [
      "a DoD with no criteria",
      [TRIAGE.replace(/^1\..*$/m, "").replace(/^2\..*$/m, ""), VERDICT_BLOCK("match", "match")],
      "dod-rejected",
    ],
    [
      "a reply that does not parse",
      ["not a report at all", VERDICT_BLOCK("match", "match")],
      "unverifiable",
    ],
    ["an agent that throws", [], "unverifiable"],
  ];

  for (const [name, replies, code] of cases) {
    it(`refuses ${name}`, async () => {
      deps = depsWith(replies);
      if (replies.length === 0)
        deps.agent = async () => {
          throw new Error("pi exited 1: boom");
        };

      const [outcome] = await prepare(deps, POLICY, REQUEST);

      expect(outcome).toMatchObject({ ok: false, code });
      expect(calls.labels).toEqual([]);
      expect(calls.comments[0]?.text).toContain(code);
      expect(existsSync(join(cwd, "batches/b7/tickets/42/refusal.json"))).toBe(true);
    });
  }

  it("refuses a model the manifest pins but the registry cannot resolve", async () => {
    deps = {
      ...depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]),
      preflight: async (slugs) =>
        slugs.map((slug) => ({ slug, ok: slug !== "deepseek/deepseek-v4-pro" })),
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({
      ok: false,
      code: "model-unavailable",
      detail: "deepseek/deepseek-v4-pro",
    });
    expect(calls.labels).toEqual([]);
  });

  it("refuses a manifest the schema rejects, before any comment", async () => {
    writeFileSync(join(cwd, "broken.yaml"), "version: '1.2'\nsession: {}\nagents: []\n");
    const policy: BatchPolicy = {
      ...POLICY,
      prepare: { ...POLICY.prepare, kindTemplates: { "code-fix": join(cwd, "broken.yaml") } },
    };
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);

    const [outcome] = await prepare(deps, policy, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "manifest-invalid" });
    // A refusal comment is the point; what must never happen is an accepted one or a label.
    expect(calls.comments[0]?.text).toContain("refused");
    expect(calls.labels).toEqual([]);
  });

  it("refuses a missing template", async () => {
    const policy: BatchPolicy = {
      ...POLICY,
      prepare: {
        ...POLICY.prepare,
        kindTemplates: { "code-fix": "templates/does-not-exist.yaml" },
      },
    };
    const [outcome] = await prepare(
      depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]),
      policy,
      REQUEST,
    );

    expect(outcome).toMatchObject({ ok: false, code: "template-missing" });
    expect(calls.comments[0]?.text).toContain("refused");
    expect(calls.labels).toEqual([]);
  });
});

describe("prepare — dry run", () => {
  it("verifies but writes nothing at all", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    const [outcome] = await prepare(deps, POLICY, REQUEST, { dryRun: true });

    expect(outcome).toMatchObject({ ok: true, kind: "code-fix" });
    expect(calls.comments).toEqual([]);
    expect(calls.labels).toEqual([]);
    expect(existsSync(join(cwd, "batches"))).toBe(false);
    expect(existsSync(join(cwd, "mypi-tasks"))).toBe(false);
  });

  it("still removes the clone", async () => {
    let removed = 0;
    deps = {
      ...depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]),
      clone: {
        make: async () => cwd,
        remove: async () => {
          removed += 1;
        },
      },
    };

    await prepare(deps, POLICY, REQUEST, { dryRun: true });

    expect(removed).toBe(1);
  });
});

describe("commentText", () => {
  it("lists every criterion once", async () => {
    const { commentText, assertCommentCriteria } = await import("../../src/batch/prepare");
    const text = commentText({
      accepted: true,
      kind: "code-fix",
      slug: "b-b7-t42",
      criteria: ["a", "b"],
    });
    expect(() => assertCommentCriteria(text, ["a", "b"])).not.toThrow();
    expect(() => assertCommentCriteria(text, ["a"])).toThrow(/do not match/);
  });
});

describe("manifestSlugs", () => {
  it("collects the supervisor and every agent", async () => {
    const { manifestSlugs } = await import("../../src/batch/prepare");
    expect(manifestSlugs(readFileSync("templates/batch-code-fix.yaml", "utf8")).sort()).toEqual(
      [
        "deepseek/deepseek-flash",
        "deepseek/deepseek-v4-pro",
        "fireworks/accounts/fireworks/models/glm-5p3-flash",
        "openrouter/openai/gpt-6-luna",
      ].sort(),
    );
  });
});
