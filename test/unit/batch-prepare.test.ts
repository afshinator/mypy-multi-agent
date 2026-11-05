import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BatchPolicy } from "../../src/batch/policy";
import { type PrepareDeps, prepare } from "../../src/batch/prepare";
import type { BatchRequest } from "../../src/batch/request";
import type { CommentRef, TicketSnapshot } from "../../src/batch/tracker";
import { parseSessionConfig } from "../../src/contracts/session-schema";

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

const VERDICT_BLOCK = (...verdicts: ("match" | "mismatch")[]) => {
  const rows = verdicts
    .map((v, i) => `{"row":${i + 1},"verdict":"${v}","evidence":"seen"}`)
    .join(",");
  const dod = verdicts
    .map((_v, i) => `{"criterion":${i + 1},"verdict":"match","evidence":"ok"}`)
    .join(",");
  return `\`\`\`json\n[${rows}]\n\`\`\`\n\ncould-not-run: none\n\n\`\`\`json\n[${dod}]\n\`\`\`\n`;
};

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
    tracker: tracker(),
    agent: async () => ({ text: replies[i++] ?? "", costUsd: 0.01 }),
    preflight: async (slugs: string[]) => slugs.map((slug) => ({ slug, ok: true })),
    clone: { make: async () => cwd, remove: async () => {} },
  };
}

/** A deps whose agent counts its calls, so a test can assert a refusal happened before any spend. */
function countingDeps(): { deps: PrepareDeps; agentCalls: () => number } {
  let n = 0;
  return {
    deps: {
      ...depsWith([]),
      agent: async () => {
        n += 1;
        return { text: "", costUsd: 0 };
      },
    },
    agentCalls: () => n,
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

    const manifestPath = join(cwd, "mypi-tasks/000-batches/b7/tickets/42/manifest.yaml");
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

  it("keeps the triage reply and the verifier block with the record", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST);

    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("## Claim checks");
    const verdicts = JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf8")) as {
      verdicts: { row: number; verdict: string }[];
    };
    expect(verdicts.verdicts.map((v) => v.verdict)).toEqual(["match", "match"]);
  });

  it("keeps the evidence of a refusal too, which is when it is worth reading", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "mismatch")]);
    await prepare(deps, POLICY, REQUEST);

    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("## Claim checks");
    expect(readFileSync(join(dir, "verdicts.json"), "utf8")).toContain("mismatch");
    expect(existsSync(join(dir, "refusal.json"))).toBe(true);
  });

  it("refuses when the verifier flags a DoD criterion as unsound", async () => {
    const dodMismatch =
      '```json\n[{"row":1,"verdict":"match","evidence":"seen"},{"row":2,"verdict":"match","evidence":"seen"}]\n```\n\ncould-not-run: none\n\n```json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"mismatch","evidence":"unsound"}]\n```\n';
    deps = depsWith([TRIAGE, dodMismatch]);
    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(calls.comments[0]?.text).toContain("refused");
  });

  it("writes no evidence and no record under --dry-run", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST, { dryRun: true });

    expect(existsSync(join(cwd, "mypi-tasks/000-batches"))).toBe(false);
  });

  it("does not run or verify when the ticket is already closed", async () => {
    ticket = { ...ticket, state: "CLOSED" };
    const counted = countingDeps();
    deps = counted.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "not-needed" });
    expect(counted.agentCalls()).toBe(0);
    expect(calls.labels).toEqual([]);
  });

  it("skips a ticket labelled not-batched without running any agent", async () => {
    ticket = { ...ticket, labels: ["not-batched"] };
    const counted = countingDeps();
    deps = counted.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "skipped" });
    expect(counted.agentCalls()).toBe(0);
    expect(calls.labels).toEqual([]);
    // A refusal still posts the marker comment carrying the reason code.
    expect(calls.comments[0]?.text).toContain("skipped");
  });

  it("reports a closed not-batched ticket as not-needed, not skipped", async () => {
    ticket = { ...ticket, state: "CLOSED", labels: ["not-batched"] };
    deps = depsWith([]);

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "not-needed" });
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
    ["a verifier reply that does not parse", [TRIAGE, "not a block"], "unverifiable"],
    ["an agent that throws", [], "infra-error"],
  ];

  for (const [name, replies, code] of cases) {
    it(`refuses ${name}`, async () => {
      deps = depsWith(replies);
      if (replies.length === 0)
        deps.agent = async () => {
          throw new Error("pi reply stopped with an error: Connection error.");
        };

      const [outcome] = await prepare(deps, POLICY, REQUEST);

      expect(outcome).toMatchObject({ ok: false, code });
      expect(calls.labels).toEqual([]);
      expect(calls.comments[0]?.text).toContain(code);
      expect(existsSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"))).toBe(true);
    });
  }

  it("records a tracker fault before any agent ran as infra-error (#299)", async () => {
    // `tracker.view` sits outside the agent guards: a transient HTTP fault there was
    // recorded as `unverifiable`, the same code as "this ticket cannot be verified".
    deps = {
      ...depsWith([]),
      tracker: {
        ...tracker(),
        view: async () => {
          throw new Error("gh: HTTP 502");
        },
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error", detail: "gh: HTTP 502" });
  });

  it("records a connection fault on the verifier call as infra-error, not a refusal", async () => {
    // The live failure was on the verifier call: the triage succeeded, then the gateway
    // dropped. It is infra noise, so it must not read as a verdict on the ticket (#293).
    const replies = [TRIAGE];
    let calls = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        calls += 1;
        if (calls === 1) return { text: replies[0] ?? "", costUsd: 0.01 };
        throw new Error("pi reply stopped with an error: Connection error.");
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({
      ok: false,
      code: "infra-error",
      detail: "pi reply stopped with an error: Connection error.",
    });
    // The triage was paid for, so its cost stays on the outcome.
    expect(outcome?.costUsd).toBe(0.01);
    const refusal = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"), "utf8"),
    ) as { code: string };
    expect(refusal.code).toBe("infra-error");
    expect(calls).toBe(2);
  });

  it("refuses a No-DoD reply as dod-rejected, not as a missing KIND", async () => {
    const noDod = TRIAGE.replace(/^1\..*$/m, "")
      .replace(/^2\..*$/m, "")
      .replace(
        "## Definition of Done\n",
        "## Definition of Done\nNo DoD: N2 the fix cannot reach the failing path\n",
      )
      .replace("KIND: code-fix", "");

    const [outcome] = await prepare(
      depsWith([noDod, VERDICT_BLOCK("match", "match")]),
      POLICY,
      REQUEST,
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: "dod-rejected",
      detail: "No DoD: N2 the fix cannot reach the failing path",
    });
    expect(calls.labels).toEqual([]);
  });

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
    expect(existsSync(join(cwd, "mypi-tasks/000-batches"))).toBe(false);
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

describe("the record says what prepare decided (#247)", () => {
  it("writes an acceptance record for an accepted ticket", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST);

    const record = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/acceptance.json"), "utf8"),
    ) as { ticket: number; kind: string; slug?: string; criteria: string[]; costUsd: number };
    expect(record).toMatchObject({ ticket: 42, kind: "code-fix", slug: "b-b7-t42" });
    expect(record.criteria).toHaveLength(2);
    expect(record.costUsd).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"))).toBe(false);
  });

  it("clears a refusal left by an earlier run when the ticket is later accepted", async () => {
    // The live case: refused, the ticket was fixed, the re-prepare accepted.
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "refusal.json"), '{"code":"dod-rejected"}\n');

    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST);

    expect(existsSync(join(dir, "refusal.json"))).toBe(false);
    expect(existsSync(join(dir, "acceptance.json"))).toBe(true);
  });

  it("clears an acceptance when a later run refuses, and writes no acceptance", async () => {
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "acceptance.json"), '{"kind":"code-fix"}\n');

    deps = depsWith([TRIAGE, VERDICT_BLOCK("mismatch", "match")]);
    await prepare(deps, POLICY, REQUEST);

    expect(existsSync(join(dir, "acceptance.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "refusal.json"), "utf8"))).toMatchObject({
      code: "verifier-mismatch",
    });
  });

  it("writes neither record under --dry-run", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST, { dryRun: true });
    expect(existsSync(join(cwd, "mypi-tasks/000-batches"))).toBe(false);
  });

  // D9: prepare no longer materialises the checkout task dir; run does. A code-fix
  // acceptance leaves only the record's manifest.yaml, never a launchable task dir.
  it("writes the record manifest but no checkout task dir for a code-fix acceptance", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST);

    expect(existsSync(join(cwd, "mypi-tasks/b-b7-t42"))).toBe(false);
    expect(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/manifest.yaml"), "utf8"),
    ).toContain("b-b7-t42");
  });

  it("reads the triage prompt from the driver, not the target repo (#299, #278)", async () => {
    // #292 replaced the #278 prompt test with a template one, so prompt resolution had no
    // coverage: the target here is a bare tmp dir and the prompt must still be the driver's.
    let captured = "";
    deps = {
      ...depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]),
      agent: async ({ prompt }) => {
        if (captured === "") captured = prompt;
        return { text: [TRIAGE, VERDICT_BLOCK("match", "match")][0] ?? "", costUsd: 0.01 };
      },
    };

    await prepare(deps, POLICY, REQUEST);

    // A line that exists only in the driver's docs/explorations/triage-automation/triage-prompt.md.
    expect(captured).toContain("FUNCTION AND ARTIFACT");
    expect(captured).toContain("#42");
  });

  it("uses the driver's code-fix template, not a same-named one in the target", async () => {
    // The target (cwd) is a foreign repo: plant a broken template there and prove prepare
    // still builds the manifest from the driver's template (#287/#292).
    mkdirSync(join(cwd, "templates"), { recursive: true });
    writeFileSync(
      join(cwd, "templates/batch-code-fix.yaml"),
      "version: '1.2'\nsession: {}\nagents: []\n",
    );
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, kind: "code-fix", slug: "b-b7-t42" });
  });
});
