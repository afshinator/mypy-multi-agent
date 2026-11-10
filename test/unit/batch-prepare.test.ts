import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ChildHandle, runAgent } from "../../src/batch/agent";
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

/** The two claim commands in the TRIAGE fixture, in row order. */
const TRIAGE_COMMANDS = [
  `sed -n '66,85p' src/supervisor/finalization.ts`,
  `rg -n "criteriaMismatches" src/`,
];

/** One claim-row entry, with the run facts every reply must now carry (#462). */
const ROW_JSON = (
  row: number,
  verdict: "match" | "mismatch",
  evidence: string,
  command = TRIAGE_COMMANDS[row - 1] ?? "true",
  exit = 0,
) => JSON.stringify({ row, verdict, evidence, command, exit });

const VERDICT_BLOCK = (...verdicts: ("match" | "mismatch")[]) => {
  const rows = verdicts.map((v, i) => ROW_JSON(i + 1, v, "seen")).join(",");
  const dod = verdicts
    .map((_v, i) => `{"criterion":${i + 1},"verdict":"match","evidence":"ok"}`)
    .join(",");
  return `\`\`\`json\n[${rows}]\n\`\`\`\n\ncould-not-run: none\n\n\`\`\`json\n[${dod}]\n\`\`\`\n`;
};

const REPAIR = (entries: string) => `\`\`\`json\n[${entries}]\n\`\`\``;
/** A well-formed block for the two-row TRIAGE fixture. */
const OK_BLOCK = VERDICT_BLOCK("match", "match");
/** Parses, but carries one verdict for two claim rows. */
const MALFORMED_BLOCK = `\`\`\`json\n[${ROW_JSON(1, "match", "x")}]\n\`\`\`\n\ncould-not-run: none\n\n\`\`\`json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"match","evidence":"ok"}]\n\`\`\``;

/** A well-formed re-verification: the flagged rows' repaired command is `fixed` by default. */
const REVERIFY = (rows: string, command = "fixed", exit = 0) =>
  `\`\`\`json\n[${(JSON.parse(`[${rows}]`) as Record<string, unknown>[])
    .map((r) => JSON.stringify({ ...r, command, exit }))
    .join(",")}]\n\`\`\`\n\ncould-not-run: none\n\n\`\`\`json\n[]\n\`\`\``;
const DOD_MISMATCH = `\`\`\`json\n[${ROW_JSON(1, "match", "seen")},${ROW_JSON(2, "match", "seen")}]\n\`\`\`\n\ncould-not-run: none\n\n\`\`\`json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"mismatch","evidence":"unsound"}]\n\`\`\``;

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

/**
 * Scripted replies with call counting, the prompts as they were sent, and optional call numbers
 * that throw instead. One stub for both jobs: a test that reads a prompt must not run a second
 * copy of the sequence (#389).
 */
function scripted(replies: string[], throws: number[] = []) {
  let attempts = 0;
  let served = 0;
  const prompts: string[] = [];
  return {
    prompts,
    deps: {
      ...depsWith([]),
      agent: async (input: { prompt: string }) => {
        attempts += 1;
        prompts.push(input.prompt);
        if (throws.includes(attempts)) {
          throw new Error("pi reply stopped with an error: Connection error.");
        }
        // Only a call that answers consumes a scripted reply, so a retry gets the next one.
        return { text: replies[served++] ?? "", costUsd: 0.01 };
      },
    },
    calls: () => attempts,
  };
}

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

  it("names what each offered kind is for, so the choice is not a bare name", async () => {
    const prompts: string[] = [];
    deps = {
      ...depsWith([]),
      agent: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          text: prompts.length === 1 ? TRIAGE : VERDICT_BLOCK("match", "match"),
          costUsd: 0.01,
        };
      },
    };
    await prepare(deps, POLICY, REQUEST);
    expect(prompts[0]).toContain(
      "- code-fix: two engineers implement the DoD in parallel; a read-only reviewer attests",
    );
    expect(prompts[0]).not.toContain("writer-solo:");
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
    deps = depsWith([TRIAGE, DOD_MISMATCH]);
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
    [
      "a verifier mismatch",
      [
        TRIAGE,
        VERDICT_BLOCK("match", "mismatch"),
        REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
        REVERIFY('{"row":1,"verdict":"mismatch","evidence":"still differs"}'),
      ],
      "verifier-mismatch",
    ],
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
    // Since #368 the fault is retried once before it refuses.
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
      retried: ["verifier"],
    });
    // The triage was paid for, so its cost stays on the outcome.
    expect(outcome?.costUsd).toBe(0.01);
    const refusal = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"), "utf8"),
    ) as { code: string };
    expect(refusal.code).toBe("infra-error");
    expect(calls).toBe(3); // triage, verifier, verifier retry
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
        "commandcode/gpt-6-luna",
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

  it("leaves an acceptance standing when a later prepare would refuse (#424)", async () => {
    // The live case: accepted, not yet run, re-prepared with a mistyped --kind. The guard
    // outranks the caller's mistake, so nothing is spent and the record is not touched.
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);
    await prepare(deps, POLICY, REQUEST);
    const before = readFileSync(join(dir, "acceptance.json"), "utf8");
    const markers = calls.comments.length;

    const outcomes = await prepare(depsWith([]), POLICY, REQUEST, { kind: "not-a-kind" });

    expect(outcomes[0]).toMatchObject({ ok: false, code: "already-prepared" });
    expect(readFileSync(join(dir, "acceptance.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "refusal.json"))).toBe(false);
    expect(calls.comments).toHaveLength(markers);
  });

  it("leaves an acceptance standing when an acceptance and a run record both exist (#424)", async () => {
    // Both files present is the state a completed run leaves behind, so the guard must
    // not key on `run.json` alone: a mistyped --kind reached the write path through the
    // gap between the two.
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    await prepare(depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]), POLICY, REQUEST);
    writeFileSync(join(dir, "run.json"), "{}\n");
    const before = readFileSync(join(dir, "acceptance.json"), "utf8");

    const outcomes = await prepare(depsWith([]), POLICY, REQUEST, { kind: "not-a-kind" });

    expect(outcomes[0]).toMatchObject({ ok: false, code: "already-prepared" });
    expect(readFileSync(join(dir, "acceptance.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "refusal.json"))).toBe(false);
  });

  it("a second prepare on an accepted ticket spends nothing (#424)", async () => {
    const { deps: counting, agentCalls } = countingDeps();
    await prepare(depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]), POLICY, REQUEST);

    const outcomes = await prepare(counting, POLICY, REQUEST);

    expect(outcomes[0]).toMatchObject({ ok: false, code: "already-prepared" });
    expect(agentCalls()).toBe(0);
  });

  it("a refusal reached before the guard still leaves the acceptance byte-identical (#424)", async () => {
    // Guard order must not matter: `not-needed` is checked before `already-prepared`, so this
    // refusal reaches the write path with an acceptance on disk. The write path, not the
    // guard, is what must keep the record.
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    await prepare(depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]), POLICY, REQUEST);
    const before = readFileSync(join(dir, "acceptance.json"), "utf8");
    ticket.state = "CLOSED";

    const outcomes = await prepare(depsWith([]), POLICY, REQUEST, { kind: "not-a-kind" });

    expect(outcomes[0]).toMatchObject({ ok: false, code: "not-needed" });
    expect(readFileSync(join(dir, "acceptance.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "refusal.json"))).toBe(false);
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

/** A report whose second command reads a variable nothing sets — a dialect fault (#401). */
const DIALECT_TRIAGE = `## Claim checks
| claim | command | observed | verdict |
| --- | --- | --- | --- |
| The gate folds backticks | \`sed -n '66,85p' src/supervisor/finalization.ts\` | fold() strips them | true |
| The log count matches | \`grep -c toolCallId "$LOG"\` | 1180 | true |

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

/** A block that names one row could-not-run while giving it a verdict, which the prompt allows. */
const COULD_NOT_RUN_BLOCK = (row: number) =>
  `\`\`\`json\n[${ROW_JSON(1, "match", "seen")},${ROW_JSON(2, "mismatch", "grep: LOG is unset", `grep -c toolCallId "$LOG"`, 2)}]\n\`\`\`\n\ncould-not-run: rows ${row}\n\n\`\`\`json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"match","evidence":"ok"}]\n\`\`\`\n`;

describe("prepare — repair round", () => {
  it("repairs a flagged claim row and accepts, with exactly two extra calls", async () => {
    let n = 0;
    const replies = [
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ];
    deps = {
      ...depsWith([]),
      agent: async () => ({ text: replies[n++] ?? "", costUsd: 0.01 }),
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(n).toBe(4); // triage + verifier + repair + reverify
    expect(outcome).toMatchObject({ ok: true, kind: "code-fix", slug: "b-b7-t42" });
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    expect(readFileSync(join(dir, "repair.md"), "utf8")).toContain("row");
    expect(existsSync(join(dir, "reverdicts.json"))).toBe(true);
  });

  it("refuses a repair that changes the DoD, recorded as unverifiable", async () => {
    // The author answers with a criterion key, not the three allowed keys.
    const bad = '```json\n[{"row":2,"command":"x","observed":"x","criterion":"changed"}]\n```\n';
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "mismatch"), bad]);

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
  });

  it("runs no repair round for a DoD-criterion mismatch", async () => {
    let n = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        n += 1;
        return { text: n === 1 ? TRIAGE : n === 2 ? DOD_MISMATCH : "", costUsd: 0 };
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(n).toBe(2); // no repair, no reverify
  });

  it("keeps the second re-verification reply when both attempts fail (#391)", async () => {
    deps = depsWith([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      // Neither reply lines up with the flagged rows, so both attempts are rejected.
      REVERIFY('{"row":7,"verdict":"match","evidence":"first attempt reached row 7"}'),
      REVERIFY('{"row":8,"verdict":"match","evidence":"second attempt reached row 8"}'),
    ]);

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable", retried: ["re-verify"] });
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    // Attempt 1 replaced, attempt 2 refused: #375 asks for both on disk, so neither may be
    // dropped by the `ok` check that ends the site.
    expect(readFileSync(join(dir, "retries.json"), "utf8")).toContain(
      "first attempt reached row 7",
    );
    expect(readFileSync(join(dir, "reverdicts.json"), "utf8")).toContain(
      "second attempt reached row 8",
    );
  });

  it("refuses after a repair that still does not reproduce, with both rounds on disk", async () => {
    deps = depsWith([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"mismatch","evidence":"still differs"}'),
    ]);

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    expect(existsSync(join(dir, "repair.md"))).toBe(true);
    expect(existsSync(join(dir, "reverdicts.json"))).toBe(true);
    expect(readFileSync(join(dir, "refusal.json"), "utf8")).toContain("verifier-mismatch");
  });
});

describe("prepare — a command nobody can run is repaired, not refused (#401)", () => {
  it("repairs the could-not-run row whose command is the fault, in one round", async () => {
    const stub = scripted([
      DIALECT_TRIAGE,
      COULD_NOT_RUN_BLOCK(2),
      REPAIR('{"row":2,"command":"grep -c toolCallId \\"logs/run.jsonl\\"","observed":"1180"}'),
      REVERIFY(
        '{"row":1,"verdict":"match","evidence":"1180"}',
        'grep -c toolCallId "logs/run.jsonl"',
      ),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(4); // triage + verifier + repair + re-verify
    expect(outcome).toMatchObject({ ok: true, kind: "code-fix", slug: "b-b7-t42" });
  });

  it("still refuses a could-not-run row whose command is clean — the target is absent", async () => {
    const stub = scripted([TRIAGE, COULD_NOT_RUN_BLOCK(2)]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(2); // no repair round for an absent target
    expect(outcome).toMatchObject({ ok: false, code: "harness-error" });
  });

  it("refuses a repair that re-publishes two code spans (#463)", async () => {
    const block = (rows: unknown[]) =>
      `\`\`\`json\n${JSON.stringify(rows)}\n\`\`\`\n\ncould-not-run: rows 2\n\n\`\`\`json\n${JSON.stringify(
        [
          { criterion: 1, verdict: "match", evidence: "ok" },
          { criterion: 2, verdict: "match", evidence: "ok" },
        ],
      )}\n\`\`\``;
    const stub = scripted([
      DIALECT_TRIAGE,
      block([
        {
          row: 1,
          verdict: "match",
          evidence: "seen",
          command: "sed -n '66,85p' src/supervisor/finalization.ts",
          exit: 0,
        },
        {
          row: 2,
          verdict: "mismatch",
          evidence: "two spans",
          command: "`grep -c x y`; `ls`",
          exit: 2,
        },
      ]),
      REPAIR(JSON.stringify({ row: 2, command: "`ls a`; `ls b`", observed: "both" })),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    // The re-verify is never paid for: a command that kept its delimiters cannot run.
    expect(stub.calls()).toBe(3);
    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome?.detail).toContain("backtick");
  });

  it("refuses a repair that answers with another command nobody can run", async () => {
    const stub = scripted([
      DIALECT_TRIAGE,
      COULD_NOT_RUN_BLOCK(2),
      REPAIR('{"row":2,"command":"grep -c toolCallId \\"…\\"","observed":"1180"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    // The re-verify is never paid for: a command with an ellipsis cannot run.
    expect(stub.calls()).toBe(3);
    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome?.detail).toContain("row 2");
    expect(outcome?.detail).toContain("U+2026");
  });
});

describe("prepare — one retry per call site (#368)", () => {
  it("retries a thrown triage once, and the accepted record sums both attempts", async () => {
    const stub = scripted([TRIAGE, VERDICT_BLOCK("match", "match")], [1]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(3); // triage, triage retry, verifier
    expect(outcome).toMatchObject({ ok: true, kind: "code-fix", retried: ["triage"] });
    expect(outcome?.costUsd).toBe(0.02); // two paid calls, not one
    const record = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/acceptance.json"), "utf8"),
    ) as { retried: string[]; costUsd: number };
    expect(record.retried).toEqual(["triage"]);
    expect(record.costUsd).toBe(0.02);
  });

  it("refuses infra-error when the call throws twice, and names the site", async () => {
    const stub = scripted([TRIAGE], [1, 2]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(2);
    expect(outcome).toMatchObject({ ok: false, code: "infra-error", retried: ["triage"] });
    const refusal = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"), "utf8"),
    ) as { retried: string[] };
    expect(refusal.retried).toEqual(["triage"]);
  });

  it("re-asks the verifier for a malformed block", async () => {
    // One verdict for two rows: the block parses but does not line up.
    const stub = scripted([TRIAGE, VERDICT_BLOCK("match"), VERDICT_BLOCK("match", "match")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(3);
    expect(outcome).toMatchObject({ ok: true, retried: ["verifier"] });
    expect(outcome?.costUsd).toBe(0.03);
  });

  it("refuses unverifiable when the block is malformed twice", async () => {
    const stub = scripted([TRIAGE, VERDICT_BLOCK("match"), VERDICT_BLOCK("match")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(3);
    expect(outcome).toMatchObject({ ok: false, code: "unverifiable", retried: ["verifier"] });
  });

  it("re-asks a repair reply that does not parse, then uses the good one", async () => {
    const stub = scripted([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      "not json",
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(5);
    expect(outcome).toMatchObject({ ok: true, retried: ["repair"] });
  });

  it("re-asks a re-verification that does not line up with the flagged rows", async () => {
    const stub = scripted([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      // Two entries for one flagged row: parses fine, does not line up.
      REVERIFY(
        '{"row":1,"verdict":"match","evidence":"a"},{"row":2,"verdict":"match","evidence":"b"}',
      ),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(5);
    expect(outcome).toMatchObject({ ok: true, retried: ["re-verify"] });
  });

  it("never re-pulls triage prose: a triage reply that does not parse costs one call", async () => {
    const stub = scripted(["not a report at all", VERDICT_BLOCK("match", "match")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(1);
    expect(outcome).toMatchObject({ ok: false, code: "unverifiable", retried: [] });
  });

  it("does not retry a verdict: a mismatch goes straight to the repair round", async () => {
    const stub = scripted([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(4); // triage + verifier + repair + reverify, no retry
    expect(outcome).toMatchObject({ ok: true, retried: [] });
  });

  it("leaves an untroubled prepare at one call per site", async () => {
    const stub = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(2);
    expect(outcome).toMatchObject({ ok: true, costUsd: 0.02, retried: [] });
  });
});

describe("prepare — re-verification naming (#372)", () => {
  /** The one flagged row is original row 2, so table position 1 and row number 2 both appear. */
  const CONTEXT = [
    TRIAGE,
    VERDICT_BLOCK("match", "mismatch"),
    REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
  ];
  const REVERIFY_CNR = (cnr: string, verdict = "match") =>
    `\`\`\`json\n[${ROW_JSON(1, verdict as "match" | "mismatch", "saw it", "fixed")}]\n\`\`\`\n\ncould-not-run: ${cnr}\n\n\`\`\`json\n[]\n\`\`\``;

  it("refuses a re-verification that names a could-not-run row as a match", async () => {
    // #354's rule, applied to the re-verify block: an undecidable row is a mismatch, so a match
    // beside it is the reply contradicting itself. Before #372 the match was merged and accepted.
    const stub = scripted([...CONTEXT, REVERIFY_CNR("1"), REVERIFY_CNR("1")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(5);
    expect(outcome).toMatchObject({
      ok: false,
      code: "unverifiable",
      retried: ["re-verify"],
    });
    expect(outcome?.detail).toContain("contradicts itself");
  });

  it("refuses a could-not-run row outside the rows it re-verified, instead of dropping it", async () => {
    const stub = scripted([...CONTEXT, REVERIFY_CNR("7"), REVERIFY_CNR("7")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome?.detail).toContain("outside the rows re-verified");
  });

  it("accepts a could-not-run row that carries a mismatch, and merges it", async () => {
    const stub = scripted([...CONTEXT, REVERIFY_CNR("1", "mismatch")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    // The merged block now names an unrunnable row, which the main gate refuses as a harness
    // fault — the verifier could not decide it, so it is not a verdict on the ticket.
    expect(stub.calls()).toBe(4);
    expect(outcome).toMatchObject({ ok: false, code: "harness-error" });
  });

  it("accepts either numbering: the re-table's 1..n, or the original row number", async () => {
    const tableOrdered = scripted([
      ...CONTEXT,
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);
    deps = tableOrdered.deps;
    const [fromTable] = await prepare(deps, POLICY, REQUEST);

    const originalNumbered = scripted([
      ...CONTEXT,
      REVERIFY('{"row":2,"verdict":"match","evidence":"reproduces"}'),
    ]);
    // A fresh record: a second prepare on an accepted ticket is now `already-prepared` (#424).
    rmSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42"), { recursive: true, force: true });
    deps = originalNumbered.deps;
    const [fromOriginal] = await prepare(deps, POLICY, REQUEST);

    expect(fromTable).toMatchObject({ ok: true });
    expect(fromOriginal).toMatchObject({ ok: true });
    expect(tableOrdered.calls()).toBe(4);
    expect(originalNumbered.calls()).toBe(4);
  });

  it("keeps a still-mismatched row a verifier-mismatch, never a retried shape fault", async () => {
    const stub = scripted([
      ...CONTEXT,
      REVERIFY('{"row":1,"verdict":"mismatch","evidence":"still differs"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(4);
    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(outcome?.retried ?? []).not.toContain("re-verify");
  });
});

describe("prepare — the record keeps the retry (#373)", () => {
  const refusalOf = () =>
    JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"), "utf8"),
    );

  it("keeps the retry and the spend when the model preflight throws afterwards", async () => {
    // The catch that turns any unexpected throw into `infra-error` used to build a fresh outcome,
    // so a prepare that had already paid for a retried triage recorded a free, un-retried run.
    const stub = scripted([TRIAGE, OK_BLOCK], [1]);
    deps = {
      ...stub.deps,
      preflight: async () => {
        throw new Error("spawn pi ENOENT");
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error", costUsd: 0.02 });
    expect(outcome?.retried).toEqual(["triage"]);
    expect(refusalOf()).toMatchObject({ code: "infra-error", costUsd: 0.02, retried: ["triage"] });
  });

  it("keeps them when the clone teardown throws, so the fix is not per call site", async () => {
    const stub = scripted([TRIAGE, OK_BLOCK], [2]);
    const dir = cwd;
    deps = {
      ...stub.deps,
      clone: {
        make: async () => dir,
        remove: async () => {
          throw new Error("rm -rf failed");
        },
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error", costUsd: 0.02 });
    expect(outcome?.retried).toEqual(["verifier"]);
    expect(refusalOf()).toMatchObject({ costUsd: 0.02, retried: ["verifier"] });
  });

  it("reports the first failure's code when a malformed reply is followed by a throw", async () => {
    // The brief: "A retry that also fails reports the code the first failure would have reported."
    // Attempt order must not decide whether the operator retries transport or re-investigates.
    const stub = scripted([TRIAGE, MALFORMED_BLOCK], [3]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable", costUsd: 0.02 });
    expect(outcome?.detail).toContain("1 verdicts for 2 rows");
    expect(outcome?.retried).toEqual(["verifier"]);
  });

  it("reports the first failure's code when a throw is followed by a malformed reply", async () => {
    const stub = scripted([TRIAGE, MALFORMED_BLOCK], [2]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error", costUsd: 0.02 });
    expect(outcome?.detail).toContain("Connection error");
  });
});

describe("prepare — the re-ask names the fault (#374)", () => {
  it("tells the second verifier what the first reply got wrong", async () => {
    const stub = scripted([TRIAGE, MALFORMED_BLOCK, OK_BLOCK]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, retried: ["verifier"] });
    // A byte-identical re-ask re-samples the same systematic mistake: the motivating failure was
    // an undercount, which no resample fixes.
    expect(stub.prompts[2]).not.toBe(stub.prompts[1]);
    expect(stub.prompts[2]).toContain("1 verdicts for 2 rows");
    expect(stub.prompts[1]).not.toContain("RETRY");
  });

  it("leaves a throw-only retry byte-identical: there is no reply to describe", async () => {
    const stub = scripted([TRIAGE, OK_BLOCK], [2]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, retried: ["verifier"] });
    expect(stub.prompts[2]).toBe(stub.prompts[1]);
  });

  it("names the fault for a repair reply that does not parse", async () => {
    const stub = scripted([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      "not json at all",
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, retried: ["repair"] });
    expect(stub.prompts[3]).toContain("RETRY");
    expect(stub.prompts[3]).toContain("no fenced");
  });

  it("names the fault for a re-verification that does not line up", async () => {
    const stub = scripted([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY(
        '{"row":1,"verdict":"match","evidence":"a"},{"row":2,"verdict":"match","evidence":"b"}',
      ),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true, retried: ["re-verify"] });
    expect(stub.prompts[4]).toContain("RETRY");
    expect(stub.prompts[4]).toContain("verdicts for 1 flagged row(s)");
  });

  it("adds nothing when nothing fails", async () => {
    const stub = scripted([TRIAGE, OK_BLOCK]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome?.retried).toEqual([]);
    expect(stub.prompts.some((p) => p.includes("RETRY"))).toBe(false);
  });
});

describe("prepare — the retry leaves a trail (#375)", () => {
  it("writes both attempts to retries.json, rejected reply first", async () => {
    const stub = scripted([TRIAGE, MALFORMED_BLOCK, OK_BLOCK]);
    deps = stub.deps;

    await prepare(deps, POLICY, REQUEST);

    const record = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/retries.json"), "utf8"),
    ) as { site: string; text: string; detail: string }[];
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ site: "verifier" });
    expect(record[0]?.text).toContain('"row":1');
    expect(record[0]?.detail).toContain("1 verdicts for 2 rows");
    // The reply that replaced it is what the record already keeps.
    expect(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/verdicts.json"), "utf8"),
    ).toContain('"row": 2');
  });

  it("keeps a throw's fault with no text, because it answered nothing", async () => {
    const stub = scripted([TRIAGE, OK_BLOCK], [2]);
    deps = stub.deps;

    await prepare(deps, POLICY, REQUEST);

    const record = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/retries.json"), "utf8"),
    ) as { site: string; text: string; detail: string }[];
    expect(record).toEqual([
      {
        site: "verifier",
        text: "",
        detail: expect.stringContaining("Connection error"),
        durationMs: expect.any(Number),
      },
    ]);
  });

  it("writes no retries.json when nothing failed", async () => {
    deps = scripted([TRIAGE, OK_BLOCK]).deps;

    await prepare(deps, POLICY, REQUEST);

    expect(existsSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/retries.json"))).toBe(false);
  });

  it("names the retried site in the accepted comment", async () => {
    deps = scripted([TRIAGE, MALFORMED_BLOCK, OK_BLOCK]).deps;

    await prepare(deps, POLICY, REQUEST);

    expect(calls.comments[0]?.text).toContain("retried: verifier");
  });

  it("names it in the refused comment too", async () => {
    // Both attempts malformed: the refusal is what a human reads, and it must say a retry happened.
    deps = scripted([TRIAGE, MALFORMED_BLOCK, MALFORMED_BLOCK]).deps;

    await prepare(deps, POLICY, REQUEST);

    expect(calls.comments[0]?.text).toContain("refused");
    expect(calls.comments[0]?.text).toContain("retried: verifier");
  });

  it("leaves the comment untouched when nothing failed", async () => {
    deps = scripted([TRIAGE, OK_BLOCK]).deps;

    await prepare(deps, POLICY, REQUEST);

    expect(calls.comments[0]?.text).not.toContain("retried");
  });
});

describe("prepare — per-ticket kinds (#465)", () => {
  const TWO_KINDS: BatchPolicy = {
    ...POLICY,
    prepare: {
      ...POLICY.prepare,
      kinds: ["code-fix", "code-small"],
      kindTemplates: {
        "code-fix": "templates/batch-code-fix.yaml",
        "code-small": "templates/code-small.yaml",
      },
    },
  };
  const MAPPED: BatchRequest = {
    id: "b7",
    tickets: [42, 43],
    kind: { 42: "code-fix", 43: "code-small" },
  };
  const TWO_TICKETS = () => [
    TRIAGE,
    VERDICT_BLOCK("match", "match"),
    TRIAGE,
    VERDICT_BLOCK("match", "match"),
  ];

  it("selects each ticket's kind and records it", async () => {
    deps = scripted(TWO_TICKETS()).deps;

    const outcomes = await prepare(deps, TWO_KINDS, MAPPED);

    expect(outcomes.map((o) => o.kind)).toEqual(["code-fix", "code-small"]);
    for (const [ticket, kind] of [
      [42, "code-fix"],
      [43, "code-small"],
    ] as const) {
      const record = JSON.parse(
        readFileSync(
          join(cwd, `mypi-tasks/000-batches/b7/tickets/${ticket}/acceptance.json`),
          "utf8",
        ),
      ) as { kind?: string };
      expect(record.kind).toBe(kind);
    }
  });

  it("tells triage the mapped kind is already decided", async () => {
    const stub = scripted(TWO_TICKETS());
    deps = stub.deps;

    await prepare(deps, TWO_KINDS, MAPPED);

    expect(stub.prompts[0]).toContain("already decided: code-fix");
    expect(stub.prompts[2]).toContain("already decided: code-small");
  });

  it("applies a scalar request kind to every ticket", async () => {
    deps = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]).deps;

    const [outcome] = await prepare(deps, POLICY, { id: "b7", tickets: [42], kind: "code-fix" });

    expect(outcome).toMatchObject({ ok: true, kind: "code-fix" });
  });

  it("refuses a pin beside a mapping before any call", async () => {
    const counted = countingDeps();

    await expect(prepare(counted.deps, TWO_KINDS, MAPPED, { kind: "code-fix" })).rejects.toThrow(
      /conflicts/,
    );
    expect(counted.agentCalls()).toBe(0);
  });
});

describe("prepare — the issue body owns the DoD (#469)", () => {
  const BODY = `# A ticket

## Definition of Done

1. body criterion one
2. body criterion two

## Notes

later prose
`;

  const BRIEF = (change: string) => `> *This was generated by AI during triage.*

## Agent Brief

**Category:** bug
**Summary:** something

**Acceptance criteria:**
As written in the issue body. Changes triage verified are needed:

- ${change}

**Out of scope:**
- nothing
`;

  const manifestDoD = () =>
    parseSessionConfig(
      parse(readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/manifest.yaml"), "utf8")),
      () => false,
    ).ask.definition_of_done;

  it("takes the criteria from the body, not the reply", async () => {
    ticket.body = BODY;
    deps = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]).deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome?.criteria).toEqual(["body criterion one", "body criterion two"]);
    expect(manifestDoD()).toEqual(["body criterion one", "body criterion two"]);
    const record = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/acceptance.json"), "utf8"),
    ) as { criteria?: string[] };
    expect(record.criteria).toEqual(["body criterion one", "body criterion two"]);
  });

  it("accepts a brief that lists no change", async () => {
    ticket.body = BODY;
    ticket.comments = [{ id: 1, body: BRIEF("(none)") }];
    deps = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]).deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome?.criteria).toEqual(["body criterion one", "body criterion two"]);
  });

  it("reads the checkbox form too", async () => {
    ticket.body = `# A ticket

## Definition of Done

- [ ] boxed one
- [x] boxed two
`;
    deps = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]).deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome?.criteria).toEqual(["boxed one", "boxed two"]);
  });

  it("tells the triage the DoD is given, so it verifies instead of authoring", async () => {
    ticket.body = BODY;
    const stub = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]);
    deps = stub.deps;

    await prepare(deps, POLICY, REQUEST);

    expect(stub.prompts[0]).toContain("THE DoD IS GIVEN");
    expect(stub.prompts[0]).toContain("body criterion one");
    // The verifier checks the body's list, not the reply's copy.
    expect(stub.prompts[1]).toContain("body criterion one");
  });

  it("leaves the authored path alone when the body states no DoD", async () => {
    const stub = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({
      ok: true,
      criteria: [
        "`normalizeDoD` strips a checkbox — proven by a unit test",
        "A manifest survives serialization",
      ],
    });
    expect(stub.prompts[0]).not.toContain("THE DoD IS GIVEN");
  });

  it("refuses a brief change the body has not taken, before any spend", async () => {
    ticket.body = BODY;
    ticket.comments = [
      { id: 1, body: BRIEF("`body criterion one` -> `body criterion one, updated`") },
    ];
    const counted = countingDeps();

    const [outcome] = await prepare(counted.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "dod-unapplied" });
    expect(outcome?.detail).toContain("body criterion one");
    expect(counted.agentCalls()).toBe(0);
  });

  it("accepts once the body carries the change", async () => {
    ticket.body = BODY.replace("1. body criterion one", "1. body criterion one, updated");
    ticket.comments = [
      { id: 1, body: BRIEF("`body criterion one` -> `body criterion one, updated`") },
    ];
    deps = scripted([TRIAGE, VERDICT_BLOCK("match", "match")]).deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome?.criteria).toContain("body criterion one, updated");
  });
});

describe("prepare — the contradiction is re-asked, shape is (#376)", () => {
  const CONTRADICTING = (rows: string) =>
    `\`\`\`json\n[${rows}]\n\`\`\`\n\ncould-not-run: rows 1\n\n\`\`\`json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"match","evidence":"ok"}]\n\`\`\``;
  const CONSISTENT_CNR = (rows: string) =>
    `\`\`\`json\n[${rows}]\n\`\`\`\n\ncould-not-run: rows 2\n\n\`\`\`json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"match","evidence":"ok"}]\n\`\`\``;
  const BOTH_MATCH = `${ROW_JSON(1, "match", "a")},${ROW_JSON(2, "match", "b")}`;
  const SECOND_MISMATCH = `${ROW_JSON(1, "match", "a")},${ROW_JSON(2, "mismatch", "b")}`;

  it("re-asks a block that names a row could-not-run and also verdicts it", async () => {
    const stub = scripted([TRIAGE, CONTRADICTING(BOTH_MATCH), CONTRADICTING(BOTH_MATCH)]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(3); // triage, verifier, verifier re-ask
    expect(outcome).toMatchObject({ ok: false, code: "unverifiable", retried: ["verifier"] });
  });

  it("does not re-ask a consistent could-not-run row: that is a harness fault, not shape", async () => {
    const stub = scripted([TRIAGE, CONSISTENT_CNR(SECOND_MISMATCH)]);
    deps = stub.deps;

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(stub.calls()).toBe(2); // triage, verifier — no re-ask
    expect(outcome).toMatchObject({ ok: false, code: "harness-error" });
    expect(outcome?.retried ?? []).toEqual([]);
  });
});

describe("prepare — the kind notes come from the prompt (#377)", () => {
  it("names only the offered kinds", async () => {
    let prompt = "";
    deps = {
      ...depsWith([]),
      agent: async (input: { prompt: string }) => {
        prompt = input.prompt;
        return { text: "", costUsd: 0.01 };
      },
    };

    await prepare(deps, POLICY, REQUEST);

    // POLICY offers one kind, and the prompt must not describe the three it does not offer.
    expect(prompt).toContain("- code-fix: two engineers implement the DoD in parallel");
    expect(prompt).not.toContain("- writer-solo:");
    // The prose beside the notes travels with them, so it is not duplicated in TypeScript.
    expect(prompt).toContain("`-solo` kinds are for criteria a command");
  });

  const unknown = {
    ...POLICY,
    prepare: {
      ...POLICY.prepare,
      kinds: ["nope"],
      kindTemplates: { nope: "templates/batch-code-fix.yaml" },
    },
  };

  it("fails rather than offering a kind the prompt cannot describe", async () => {
    deps = depsWith([TRIAGE]);

    const [outcome] = await prepare(deps, unknown, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error" });
    expect(outcome?.detail).toContain("describes no kind nope");
  });

  it("refuses an undescribed kind before it copies the checkout (#386)", async () => {
    let cloned = 0;
    deps = {
      ...depsWith([]),
      clone: {
        make: async () => {
          cloned += 1;
          return cwd;
        },
        remove: async () => {},
      },
    };

    const [outcome] = await prepare(deps, unknown, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error" });
    expect(outcome?.detail).toContain("describes no kind nope");
    // The check is static: it does not depend on the ticket, so nothing may be spent first.
    expect(cloned).toBe(0);
  });
});

describe("prepare — a spend-free refusal records no cost (#384)", () => {
  it("omits costUsd when the clone throw preceded every paid call", async () => {
    deps = {
      ...depsWith([]),
      clone: {
        make: async () => {
          throw new Error("cp: no space left");
        },
        remove: async () => {},
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error" });
    // Absent, not zero: nothing was spent, so nothing may be claimed.
    expect(outcome?.costUsd).toBeUndefined();
    const refusal = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42/refusal.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("costUsd" in refusal).toBe(false);
  });

  it("still records the summed spend when the throw came after a paid call", async () => {
    // The #373 guarantee: a fault after a retried call must not erase what was paid for.
    const stub = scripted([TRIAGE, OK_BLOCK], [1]);
    deps = {
      ...stub.deps,
      preflight: async () => {
        throw new Error("spawn pi ENOENT");
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error", costUsd: 0.02 });
  });
});

/** A child that never closes and never answers, so only a permit can end the call. */
function stuckChild(): ChildHandle {
  const emitter = new EventEmitter() as EventEmitter & ChildHandle;
  emitter.stdout = Readable.from([]);
  emitter.stderr = Readable.from([]);
  emitter.kill = () => true;
  return emitter;
}

const minutes = (n: number): BatchPolicy => ({
  ...POLICY,
  prepare: { ...POLICY.prepare, agentTimeoutMinutes: n },
});

describe("prepare — every paid call is bounded, per site (#403)", () => {
  it("derives each site's permit from the one knob: full for triage and verifier, a third for the repair round", async () => {
    const permits: number[] = [];
    const replies = [
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ];
    let n = 0;
    deps = {
      ...depsWith([]),
      agent: async (input: { timeoutMs: number }) => {
        permits.push(input.timeoutMs);
        return { text: replies[n++] ?? "", costUsd: 0.01 };
      },
    };

    const [outcome] = await prepare(deps, minutes(15), REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    // 15 min for the first look at the ticket, 5 min (a third) for a two-cell repair and its
    // re-verification. Same knob, two numbers: a hung repair must not cost a triage (#403).
    expect(permits).toEqual([900_000, 900_000, 300_000, 300_000]);
  });

  it("records how long every paid call took, on the record the reader opens", async () => {
    deps = depsWith([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"match","evidence":"reproduces"}'),
    ]);

    await prepare(deps, POLICY, REQUEST);

    const record = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42", "acceptance.json"), "utf8"),
    ) as {
      durations: Record<string, number>;
    };
    expect(Object.keys(record.durations).sort()).toEqual([
      "re-verify",
      "repair",
      "triage",
      "verifier",
    ]);
    expect(Object.values(record.durations).every((ms) => typeof ms === "number")).toBe(true);
  });

  it("refuses at the permit when a call never settles, instead of waiting out the knob", async () => {
    const policy = minutes(0.001); // 60 ms, so the test does not wait on a real minute
    deps = { ...depsWith([]), agent: (input) => runAgent(input, () => stuckChild()) };
    const started = Date.now();

    const [outcome] = await prepare(deps, policy, REQUEST);

    const elapsed = Date.now() - started;
    expect(outcome).toMatchObject({ ok: false, code: "infra-error" });
    expect(outcome?.detail).toContain("pi timed out after 60 ms");
    // Two attempts at the permit, not the doubled knob and certainly not a hang.
    expect(elapsed).toBeLessThan(1500);
    const retries = JSON.parse(
      readFileSync(join(cwd, "mypi-tasks/000-batches/b7/tickets/42", "retries.json"), "utf8"),
    ) as {
      site: string;
      durationMs: number;
    }[];
    expect(retries[0]).toMatchObject({ site: "triage" });
    expect(retries[0]?.durationMs).toBeGreaterThanOrEqual(50);
  });

  it("spends at most twice the knob on one ticket's prepare, and does not call a site the budget cannot pay for", async () => {
    // Triage answers, but overruns its 60 ms permit and the whole 120 ms deadline share in the
    // fake — which is what a slow call looks like from the prepare's side: nothing is left.
    let calls = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 400));
        return { text: TRIAGE, costUsd: 0 };
      },
    };

    const [outcome] = await prepare(deps, minutes(0.001), REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "infra-error" });
    expect(outcome?.detail).toContain("budget");
    // The verifier is refused rather than launched with a permit of zero or less, and nothing is
    // retried because nothing was called.
    expect(calls).toBe(1);
    expect(outcome?.retried).toEqual([]);
    // A site that was never called has no wall time, so nothing may claim one: absent is not
    // zero, the same rule the spend record already follows (#384, #403).
    expect(outcome?.durations && "verifier" in outcome.durations).toBe(false);
    const dir = join(cwd, "mypi-tasks/000-batches/b7/tickets/42");
    const refusal = JSON.parse(readFileSync(join(dir, "refusal.json"), "utf8")) as {
      durations: Record<string, number>;
    };
    expect("verifier" in refusal.durations).toBe(false);
    expect(existsSync(join(dir, "retries.json"))).toBe(false);
  });

  it("gives a later site what the deadline has left, not its whole permit", async () => {
    // Triage answers inside the deadline but over its own 600 ms permit, so the verifier must be
    // handed the remainder — the clamping branch, where a permit is cut short rather than refused.
    const permits: number[] = [];
    let calls = 0;
    deps = {
      ...depsWith([]),
      agent: async (input: { timeoutMs: number }) => {
        calls += 1;
        permits.push(input.timeoutMs);
        await new Promise((r) => setTimeout(r, 900));
        return { text: calls === 1 ? TRIAGE : VERDICT_BLOCK("match", "match"), costUsd: 0 };
      },
    };

    const [outcome] = await prepare(deps, minutes(0.01), REQUEST);

    expect(outcome).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(permits[0]).toBe(600);
    // Shortened by the deadline (1200 ms) minus the 900 ms triage just spent, and still positive.
    expect(permits[1]).toBeGreaterThan(0);
    expect(permits[1]).toBeLessThan(600);
  });
});

describe("--kind pins the template (#419 follow-up)", () => {
  /** POLICY offers code-fix only; give it a second kind so a pin has something to choose. */
  const twoKinds: BatchPolicy = {
    ...POLICY,
    prepare: {
      ...POLICY.prepare,
      kinds: ["code-fix", "code-small"],
      kindTemplates: {
        "code-fix": "templates/batch-code-fix.yaml",
        "code-small": "templates/code-small.yaml",
      },
    },
  };

  it("uses the pinned kind when the triage answers another one", async () => {
    const prompts: string[] = [];
    const base = depsWith([TRIAGE.replace("KIND: code-fix", "KIND: code-small"), OK_BLOCK]);
    deps = {
      ...base,
      agent: async (input) => {
        prompts.push(input.prompt);
        return base.agent(input);
      },
    };

    const [outcome] = await prepare(deps, twoKinds, REQUEST, { kind: "code-fix" });

    // The triage is told the decision is made, so it is not asked to re-take it.
    expect(prompts[0]).toContain("The kind is already decided: code-fix");
    expect(prompts[0]).not.toContain("KIND: <one of");
    expect(outcome).toMatchObject({ ok: true, kind: "code-fix" });
    const manifest = readFileSync(
      join(cwd, "mypi-tasks/000-batches/b7/tickets/42/manifest.yaml"),
      "utf8",
    );
    expect(manifest).toContain("surface_engineer");
  });

  it("refuses a pinned kind the policy does not offer, before any model call", async () => {
    let agentCalls = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        agentCalls += 1;
        return { text: "", costUsd: 0 };
      },
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST, { kind: "not-a-kind" });

    expect(outcome).toMatchObject({ ok: false, code: "kind-invalid" });
    expect(outcome && "detail" in outcome ? outcome.detail : "").toContain(
      "not-a-kind is not one of code-fix",
    );
    expect(agentCalls).toBe(0);
  });
});
