import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ChildHandle, runAgent } from "../../src/batch/agent";
import { type BatchPolicy, DEFAULT_LABELS } from "../../src/batch/policy";
import { check, PREPARE_RECORD_FILES, type PrepareDeps, prepare } from "../../src/batch/prepare";
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
  labels: DEFAULT_LABELS,
};
const REQUEST: BatchRequest = { id: "b7", tickets: [42] };

const TRIAGE = `## Claim checks
row 1: The gate folds backticks
command: sed -n '66,85p' src/supervisor/finalization.ts
observed: fold() strips them
verdict: true

row 2: The helper is used once
command: rg -n "criteriaMismatches" src/
observed: one hit
verdict: true

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
  removed: { ticket: number; label: string }[];
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
    removeLabel: async (n: number, label: string) => {
      calls.removed.push({ ticket: n, label });
      calls.order.push("removeLabel");
    },
  };
}

function depsWith(replies: string[]): PrepareDeps {
  let i = 0;
  return {
    cwd,
    tracker: tracker(),
    agent: async () => ({ text: replies[i++] ?? "", costUsd: 0.01, turns: 1 }),
    preflight: async (slugs: string[]) => slugs.map((slug) => ({ slug, ok: true })),
    clone: { make: async () => cwd, remove: async () => {} },
    revision: () => "test-revision",
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
        return { text: "", costUsd: 0, turns: 1 };
      },
    },
    agentCalls: () => n,
  };
}

/** The ticket's record root and one attempt inside it (#460). */
const ticketDir = (ticket = 42) => join(cwd, `mypi-tasks/000-batches/b7/tickets/${ticket}`);
const attemptDir = (n = 1, ticket = 42) => join(ticketDir(ticket), "attempts", String(n));

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mypi-prepare-"));
  calls = { comments: [], labels: [], removed: [], order: [] };
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
      agent: async (input: {
        prompt: string;
        onTurn?: (turns: number, ms: number) => void;
        onStep?: (step: { turn: number; tool: string; detail: string; toolMs?: number }) => void;
      }) => {
        attempts += 1;
        prompts.push(input.prompt);
        // The real agent narrates the stream as it arrives; the fake reports one turn and one
        // tool call, which is the shape the prepare lines are drawn from (#539).
        input.onTurn?.(1, 5);
        input.onStep?.({ turn: 1, tool: "bash", detail: "ls", toolMs: 7 });
        if (throws.includes(attempts)) {
          throw new Error("pi reply stopped with an error: Connection error.");
        }
        // Only a call that answers consumes a scripted reply, so a retry gets the next one.
        return { text: replies[served++] ?? "", costUsd: 0.01, turns: 1 };
      },
    },
    calls: () => attempts,
  };
}

describe("check — the gates that cost nothing", () => {
  it("passes an open ticket and calls neither agent (#502)", async () => {
    let called = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        called += 1;
        return { text: "", costUsd: 1, turns: 1 };
      },
    };

    const [outcome] = await check(deps, POLICY, REQUEST);

    expect(outcome).toEqual({ ticket: 42, ok: true });
    expect(called).toBe(0);
    expect(calls.comments).toEqual([]);
  });

  it("refuses a body whose DoD cannot fold, before any clone (#502)", async () => {
    ticket = { ...ticket, body: "## Definition of Done\n\n- a criterion with one `backtick\n" };
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

    const [outcome] = await check(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "dod-rejected" });
    expect(cloned).toBe(0);
  });

  it("reports the record and the opt-out label without reading the body (#502)", async () => {
    mkdirSync(ticketDir(), { recursive: true });
    writeFileSync(join(ticketDir(), "acceptance.json"), "{}\n");
    expect((await check(depsWith([]), POLICY, REQUEST))[0]).toMatchObject({
      ok: false,
      code: "already-prepared",
    });

    rmSync(ticketDir(), { recursive: true, force: true });
    ticket = { ...ticket, labels: ["not-batched"] };
    expect((await check(depsWith([]), POLICY, REQUEST))[0]).toMatchObject({
      ok: false,
      code: "skipped",
    });
  });
});

describe("prepare — a refusal says what to change", () => {
  it("prints the remedy under the reason (#502)", async () => {
    deps = depsWith([TRIAGE, DOD_MISMATCH]);
    await prepare(deps, POLICY, REQUEST);

    const text = calls.comments[0]?.text ?? "";
    expect(text).toContain("prepare refused this ticket: **verifier-mismatch**");
    expect(text).toContain("What to change: a claim in the ticket is false");
  });
});

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
          turns: 1,
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

    const dir = attemptDir();
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("## Claim checks");
    const verdicts = JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf8")) as {
      verdicts: { row: number; verdict: string }[];
    };
    expect(verdicts.verdicts.map((v) => v.verdict)).toEqual(["match", "match"]);
  });

  it("keeps the evidence of a refusal too, which is when it is worth reading", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "mismatch")]);
    await prepare(deps, POLICY, REQUEST);

    const dir = attemptDir();
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("## Claim checks");
    expect(readFileSync(join(dir, "verdicts.json"), "utf8")).toContain("mismatch");
    expect(existsSync(join(ticketDir(), "refusal.json"))).toBe(true);
  });

  it("moves the ready label off a ticket whose own text the refusal blames (#502)", async () => {
    // The policy opts in: without it the driver must not rewrite another tracker's labels.
    const policy: BatchPolicy = { ...POLICY, labels: { ...DEFAULT_LABELS, onRefusal: true } };
    // A DoD mismatch never repairs, so the refusal is the ticket's text and nothing else.
    deps = depsWith([TRIAGE, DOD_MISMATCH]);
    const [outcome] = await prepare(deps, policy, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(calls.removed).toEqual([{ ticket: 42, label: "ready-for-agent" }]);
    expect(calls.labels).toEqual([{ ticket: 42, label: "needs-info" }]);
    // The comment still comes first: the label says "not ready", the comment says why.
    expect(calls.order).toEqual(["comment", "removeLabel", "label"]);
  });

  it("leaves the labels alone when the policy has not opted in (#502)", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "mismatch")]);
    await prepare(deps, POLICY, REQUEST);

    expect(calls.removed).toEqual([]);
    expect(calls.labels).toEqual([]);
  });

  it("leaves the labels alone when the refusal blames us, not the ticket (#502)", async () => {
    const policy: BatchPolicy = { ...POLICY, labels: { ...DEFAULT_LABELS, onRefusal: true } };
    // A pinned kind the policy does not offer is the caller's mistake: retrying is the fix.
    const [outcome] = await prepare(depsWith([]), policy, { ...REQUEST, kind: "nope" });

    expect(outcome).toMatchObject({ ok: false, code: "kind-invalid" });
    expect(calls.removed).toEqual([]);
    expect(calls.labels).toEqual([]);
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
        if (calls === 1) return { text: replies[0] ?? "", costUsd: 0.01, turns: 1 };
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
    const dir = ticketDir();
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
    const dir = ticketDir();
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
    const dir = ticketDir();
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
    const dir = ticketDir();
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
        return {
          text: [TRIAGE, VERDICT_BLOCK("match", "match")][0] ?? "",
          costUsd: 0.01,
          turns: 1,
        };
      },
    };

    await prepare(deps, POLICY, REQUEST);

    // A line that exists only in the driver's docs/explorations/triage-automation/triage-prompt.md.
    expect(captured).toContain("FUNCTION AND ARTIFACT");
    expect(captured).toContain("#42");
    const flat = captured.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Check that a referenced file exists and is relevant before reading it.",
    );
    expect(flat).toContain(
      "Skip missing optional references without treating their absence as a finding or blocker.",
    );
    expect(captured).not.toContain("Read these first, relative to that directory:");
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
row 1: The gate folds backticks
command: sed -n '66,85p' src/supervisor/finalization.ts
observed: fold() strips them
verdict: true

row 2: The log count matches
command: grep -c toolCallId "$LOG"
observed: 1180
verdict: true

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
      agent: async () => ({ text: replies[n++] ?? "", costUsd: 0.01, turns: 1 }),
    };

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(n).toBe(4); // triage + verifier + repair + reverify
    expect(outcome).toMatchObject({ ok: true, kind: "code-fix", slug: "b-b7-t42" });
    const dir = attemptDir();
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
        return { text: n === 1 ? TRIAGE : n === 2 ? DOD_MISMATCH : "", costUsd: 0, turns: 1 };
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
    const dir = attemptDir();
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
    const dir = attemptDir();
    expect(existsSync(join(dir, "repair.md"))).toBe(true);
    expect(existsSync(join(dir, "reverdicts.json"))).toBe(true);
    expect(existsSync(join(dir, "merged.json"))).toBe(true);
    expect(readFileSync(join(ticketDir(), "refusal.json"), "utf8")).toContain("verifier-mismatch");
  });
});

describe("prepare — every file it writes is in the record-file list (#493)", () => {
  /** Every file under the record's tickets/, with the attempt number normalized away. */
  const recordFiles = (): string[] => {
    const found: string[] = [];
    const walk = (dir: string, relative: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(path, next);
        else found.push(next);
      }
    };
    const tickets = join(cwd, "mypi-tasks/000-batches/b7/tickets");
    if (existsSync(tickets)) walk(tickets, "");
    return found
      .map((path) => path.replace(/^\d+\/attempts\/\d+\//, "attempts/<k>/").replace(/^\d+\//, ""))
      .map((path) => `tickets/<n>/${path}`)
      .sort();
  };

  it("covers both directions: written but unlisted, and listed but never written", async () => {
    // Three tickets, so every file in the list is actually produced: a plain refusal, a repaired
    // refusal (repair.md, reverdicts.json, merged.json), and an acceptance with one retried call
    // (acceptance.json, manifest.yaml, retries.json).
    deps = depsWith([
      TRIAGE,
      DOD_MISMATCH,
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
      REVERIFY('{"row":1,"verdict":"mismatch","evidence":"still differs"}'),
      TRIAGE,
      MALFORMED_BLOCK,
      OK_BLOCK,
    ]);
    ticket.number = 42;
    const second = { ...ticket, number: 43 };
    const third = { ...ticket, number: 44 };
    const views = [ticket, second, third];
    let view = 0;
    deps.tracker.view = async () => views[view++] ?? third;

    await prepare(deps, POLICY, { id: "b7", tickets: [42, 43, 44] });

    const listed = PREPARE_RECORD_FILES.map(({ file, dir }) => `tickets/<n>/${dir}${file}`).sort();
    // Three tickets write the same normalized paths, so the union is what the list describes.
    const written = [
      ...new Set(recordFiles().filter((path) => !path.endsWith("/run.json"))), // `run` writes that
    ];
    expect(written).toEqual(listed);
  });
});

describe("prepare — an unsafe claim command is refused before the verifier runs (#483)", () => {
  const unsafeTriage = (command: string) =>
    TRIAGE.replace('command: rg -n "criteriaMismatches" src/', `command: ${command}`);

  it("refuses the row without spending the verifier call", async () => {
    const s = scripted([unsafeTriage("rm -rf ~/Documents")]);

    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome?.detail).toContain("row 2");
    expect(outcome?.detail).toContain("runs rm");
    expect(s.calls()).toBe(1); // triage only: the verifier was never asked to run it
  });

  it("refuses a row that names a path outside the clone", async () => {
    const s = scripted([unsafeTriage("cat ~/.ssh/id_rsa")]);

    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome?.detail).toContain("outside the clone");
  });

  it("does not refuse a legitimately unsafe-looking command", async () => {
    // `env PATH=/nonexistent` names an absolute path, in an assignment: triage-200 row 2 does
    // exactly this, so the containment rule must not read it as a file argument.
    const command = "env PATH=/nonexistent bun -e 'x'";
    const block = `\`\`\`json\n[${ROW_JSON(1, "match", "seen")},${JSON.stringify({ row: 2, verdict: "match", evidence: "seen", command, exit: 0 })}]\n\`\`\`\n\ncould-not-run: none\n\n\`\`\`json\n[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"match","evidence":"ok"}]\n\`\`\`\n`;
    const s = scripted([unsafeTriage(command), block]);

    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome?.ok).toBe(true);
    expect(s.calls()).toBe(2);
  });

  it("refuses a repair that smuggles an unsafe command into a flagged row", async () => {
    const s = scripted([
      TRIAGE,
      VERDICT_BLOCK("match", "mismatch"),
      REPAIR('{"row":2,"command":"rm -rf ~/Documents","observed":"gone"}'),
    ]);

    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome?.detail).toContain("repair for row 2");
    expect(s.calls()).toBe(3); // triage, verifier, repair — no re-verification
  });
});

describe("prepare — a refused attempt's triage reply is reusable (#466)", () => {
  // The triage prompt is the only one that asks for a KIND line, so this counts its calls.
  const triageCalls = (prompts: string[]) => prompts.filter((p) => p.includes("KIND:")).length;
  const decision = (n: number) =>
    JSON.parse(readFileSync(join(attemptDir(n), "decision.json"), "utf8")) as {
      code: string;
      durations: Record<string, number>;
      triage: { ran?: true; reusedFrom?: number };
    };
  const attemptFiles = (n: number) => readdirSync(attemptDir(n)).sort();

  it("says which stages ran with the file each one wrote, and nothing else", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH]);

    await prepare(s.deps, POLICY, REQUEST);

    expect(attemptFiles(1)).toEqual([
      "decision.json",
      "identity.json",
      "report.md",
      "verdicts.json",
    ]);
    expect(readFileSync(join(attemptDir(1), "report.md"), "utf8")).toBe(TRIAGE);
    expect(decision(1)).toMatchObject({ code: "verifier-mismatch" });
    expect(decision(1).durations.triage).toBeGreaterThanOrEqual(0);
    // Provenance is stated, not inferred (#484): this attempt paid for triage.
    expect(decision(1).triage).toEqual({ ran: true });
  });

  it("keeps a refused triage reply distinguishable from a completed one", async () => {
    // The reply arrived and could not be read: the report is on disk, the verifier block never was.
    const s = scripted(["## Claim checks\n\nrow 1: a\ncommand: ls a\nobserved: listed\n"]);

    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(attemptFiles(1)).toContain("report.md");
    expect(attemptFiles(1)).not.toContain("verdicts.json");
  });

  it("reads the recorded reply instead of paying for triage again", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, DOD_MISMATCH]);

    const [first] = await prepare(s.deps, POLICY, REQUEST);
    const [second] = await prepare(s.deps, POLICY, REQUEST);

    expect(first).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(second).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(triageCalls(s.prompts)).toBe(1);
    expect(s.calls()).toBe(3); // one triage call, then one verifier call per prepare
    expect(readFileSync(join(attemptDir(2), "report.md"), "utf8")).toBe(TRIAGE);
    // Provenance is stated, not inferred (#484): attempt 2 read attempt 1's reply.
    expect(decision(2).triage).toEqual({ reusedFrom: 1 });
    expect(decision(2).durations.triage).toBeUndefined();
    expect(decision(2).durations.verifier).toBeGreaterThanOrEqual(0);
    // The root record is what `run` and `status` read, so it carries the same statement.
    expect(
      JSON.parse(readFileSync(join(ticketDir(), "refusal.json"), "utf8")) as { triage?: unknown },
    ).toMatchObject({ triage: { reusedFrom: 1 } });
  });

  it("runs triage again when the issue body changed", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    await prepare(s.deps, POLICY, REQUEST);

    ticket.body = "changed after the first attempt";
    await prepare(s.deps, POLICY, REQUEST);

    expect(triageCalls(s.prompts)).toBe(2);
    expect(decision(2).durations.triage).toBeGreaterThanOrEqual(0);
    expect(decision(2).triage).toEqual({ ran: true });
  });

  it("runs triage again when the base revision changed", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    const revisions = ["rev-1", "rev-2"];
    s.deps.revision = () => revisions.shift() ?? "rev-2";

    await prepare(s.deps, POLICY, REQUEST);
    await prepare(s.deps, POLICY, REQUEST);

    expect(triageCalls(s.prompts)).toBe(2);
    expect(decision(2).durations.triage).toBeGreaterThanOrEqual(0);
  });

  it("does not reuse a recorded reply that no longer parses", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    await prepare(s.deps, POLICY, REQUEST);

    writeFileSync(join(attemptDir(1), "report.md"), "not the report it was");
    await prepare(s.deps, POLICY, REQUEST);

    expect(triageCalls(s.prompts)).toBe(2);
    expect(readFileSync(join(attemptDir(2), "report.md"), "utf8")).toBe(TRIAGE);
  });

  it("reads the newest matching attempt, not an older one it could still parse", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    await prepare(s.deps, POLICY, REQUEST); // attempt 1: reply on disk
    await prepare(s.deps, POLICY, REQUEST); // attempt 2: reuses attempt 1

    // Attempt 2 is now the newest answer and it is unreadable, so triage runs rather than
    // falling back to attempt 1, which is still parseable.
    writeFileSync(join(attemptDir(2), "report.md"), "corrupt");
    await prepare(s.deps, POLICY, REQUEST);

    expect(triageCalls(s.prompts)).toBe(2); // attempt 1, then attempt 3
    expect(decision(3).durations.triage).toBeGreaterThanOrEqual(0);
    expect(decision(3).triage).toEqual({ ran: true });
  });

  it("reuses nothing in a dry run, which reports what the ticket would cost", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    await prepare(s.deps, POLICY, REQUEST);

    await prepare(s.deps, POLICY, REQUEST, { dryRun: true });

    expect(triageCalls(s.prompts)).toBe(2);
    expect(existsSync(attemptDir(2))).toBe(false);
  });
});

describe("prepare — each attempt keeps its own record (#460)", () => {
  const mismatchThenRepair = () => [
    TRIAGE,
    VERDICT_BLOCK("match", "mismatch"),
    REPAIR('{"row":2,"command":"fixed","observed":"fixed"}'),
    REVERIFY('{"row":1,"verdict":"mismatch","evidence":"still differs"}'),
  ];

  it("persists the merged block and names it in the refusal", async () => {
    deps = depsWith(mismatchThenRepair());

    const [outcome] = await prepare(deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
    expect(outcome?.detail).toContain("mismatch on rows 2");
    expect(outcome?.detail).toContain("merged.json");
    const merged = JSON.parse(readFileSync(join(attemptDir(), "merged.json"), "utf8")) as {
      verdicts: { row: number; verdict: string }[];
    };
    expect(merged.verdicts.filter((v) => v.verdict === "mismatch").map((v) => v.row)).toEqual([2]);
  });

  it("writes a second attempt and leaves the first byte-identical", async () => {
    // A DoD-criterion mismatch never repairs, so each prepare is one triage + one verifier call.
    deps = depsWith([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    await prepare(deps, POLICY, REQUEST);
    const first = readdirSync(attemptDir())
      .sort()
      .map((name) => [name, readFileSync(join(attemptDir(), name), "utf8")] as const);

    await prepare(deps, POLICY, REQUEST);

    expect(
      readdirSync(attemptDir())
        .sort()
        .map((name) => [name, readFileSync(join(attemptDir(), name), "utf8")]),
    ).toEqual(first);
    expect(existsSync(attemptDir(2))).toBe(true);
    // The root record is what `run` and `status` read, and it is the latest attempt's.
    expect(readFileSync(join(ticketDir(), "refusal.json"), "utf8")).toBe(
      readFileSync(join(attemptDir(2), "decision.json"), "utf8"),
    );
    expect(readFileSync(join(attemptDir(1), "decision.json"), "utf8")).toContain(
      "verifier-mismatch",
    );
  });

  it("records the issue hash and the base revision, and a changed body changes the hash", async () => {
    ticket.body = "ticket text one";
    deps = depsWith([TRIAGE, DOD_MISMATCH, TRIAGE, DOD_MISMATCH]);
    await prepare(deps, POLICY, REQUEST);
    const first = JSON.parse(readFileSync(join(attemptDir(1), "identity.json"), "utf8")) as {
      issue: string;
      base: string;
    };

    ticket.body = "ticket text two";
    await prepare(deps, POLICY, REQUEST);
    const second = JSON.parse(readFileSync(join(attemptDir(2), "identity.json"), "utf8")) as {
      issue: string;
      base: string;
    };

    expect(first.base).toBe("test-revision");
    expect(first.issue).toMatch(/^[0-9a-f]{16}$/);
    expect(second.issue).not.toBe(first.issue);
  });

  it("keeps triage and the verifier in the same attempt, so a disagreement is visible", async () => {
    deps = depsWith([TRIAGE, VERDICT_BLOCK("match", "match")]);

    await prepare(deps, POLICY, REQUEST);

    expect(readFileSync(join(attemptDir(), "report.md"), "utf8")).toContain("row 1: ");
    expect(existsSync(join(attemptDir(), "verdicts.json"))).toBe(true);
    expect(existsSync(join(attemptDir(), "identity.json"))).toBe(true);
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

    const record = JSON.parse(readFileSync(join(attemptDir(), "retries.json"), "utf8")) as {
      site: string;
      text: string;
      detail: string;
    }[];
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ site: "verifier" });
    expect(record[0]?.text).toContain('"row":1');
    expect(record[0]?.detail).toContain("1 verdicts for 2 rows");
    // The reply that replaced it is what the record already keeps.
    expect(readFileSync(join(attemptDir(), "verdicts.json"), "utf8")).toContain('"row": 2');
  });

  it("keeps a throw's fault with no text, because it answered nothing", async () => {
    const stub = scripted([TRIAGE, OK_BLOCK], [2]);
    deps = stub.deps;

    await prepare(deps, POLICY, REQUEST);

    const record = JSON.parse(readFileSync(join(attemptDir(), "retries.json"), "utf8")) as {
      site: string;
      text: string;
      detail: string;
    }[];
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

    expect(existsSync(join(attemptDir(), "retries.json"))).toBe(false);
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
        return { text: "", costUsd: 0.01, turns: 1 };
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
        return { text: replies[n++] ?? "", costUsd: 0.01, turns: 1 };
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
    const retries = JSON.parse(readFileSync(join(attemptDir(), "retries.json"), "utf8")) as {
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
        return { text: TRIAGE, costUsd: 0, turns: 1 };
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
    const refusal = JSON.parse(readFileSync(join(ticketDir(), "refusal.json"), "utf8")) as {
      durations: Record<string, number>;
    };
    expect("verifier" in refusal.durations).toBe(false);
    expect(existsSync(join(attemptDir(), "retries.json"))).toBe(false);
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
        return {
          text: calls === 1 ? TRIAGE : VERDICT_BLOCK("match", "match"),
          costUsd: 0,
          turns: 1,
        };
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
        return { text: "", costUsd: 0, turns: 1 };
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

describe("prepare — per-call telemetry (#512)", () => {
  interface Called {
    site: string;
    attempt: number;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    durationMs?: number;
  }
  const record = (file: string) =>
    JSON.parse(readFileSync(join(ticketDir(), file), "utf8")) as {
      calls?: Called[];
      durations?: Record<string, number>;
    };

  /** An agent that reports what a real call reports: turns, tokens, cost. */
  function metered(
    replies: string[],
    usage: { input?: number; output?: number } = { input: 1200, output: 80 },
  ) {
    let i = 0;
    return {
      ...depsWith([]),
      agent: async () => ({
        text: replies[i++] ?? "",
        costUsd: 0.02,
        turns: 3,
        ...(usage.input === undefined ? {} : { inputTokens: usage.input }),
        ...(usage.output === undefined ? {} : { outputTokens: usage.output }),
      }),
    };
  }

  it("records turns, tokens, cost and duration per site and attempt, and nothing else", async () => {
    deps = metered([TRIAGE, OK_BLOCK]);
    const [outcome] = await prepare(deps, POLICY, REQUEST);
    expect(outcome).toMatchObject({ ok: true });

    const called = record("acceptance.json").calls ?? [];
    expect(called.map((c) => [c.site, c.attempt])).toEqual([
      ["triage", 1],
      ["verifier", 1],
    ]);
    expect(called[0]).toMatchObject({
      turns: 3,
      inputTokens: 1200,
      outputTokens: 80,
      costUsd: 0.02,
    });
    expect(typeof called[0]?.durationMs).toBe("number");
    // A key set, not a shape: no prompt, tool argument or command output can ride along.
    expect(Object.keys(called[0] ?? {}).sort()).toEqual([
      "attempt",
      "costUsd",
      "durationMs",
      "inputTokens",
      "outputTokens",
      "site",
      "turns",
    ]);
  });

  it("records the same entries when the prepare refuses", async () => {
    deps = metered([TRIAGE, DOD_MISMATCH]);
    await prepare(deps, POLICY, REQUEST);

    expect(record("refusal.json").calls?.map((c) => c.site)).toEqual(["triage", "verifier"]);
  });

  it("leaves a site that made no paid call out of the record", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH, DOD_MISMATCH]);
    await prepare(s.deps, POLICY, REQUEST);
    await prepare(s.deps, POLICY, REQUEST);

    const second = JSON.parse(readFileSync(join(attemptDir(2), "decision.json"), "utf8")) as {
      calls?: Called[];
      triage?: { reusedFrom?: number };
    };
    // The reply was read, not paid for, so there is no triage entry at all — not a zero one.
    expect(second.triage).toEqual({ reusedFrom: 1 });
    expect(second.calls?.map((c) => c.site)).toEqual(["verifier"]);
  });

  it("leaves an unreported token count out of the record", async () => {
    deps = metered([TRIAGE, OK_BLOCK], {});
    await prepare(deps, POLICY, REQUEST);

    const triageCall = record("acceptance.json").calls?.[0] ?? {};
    expect("inputTokens" in triageCall).toBe(false);
    expect("outputTokens" in triageCall).toBe(false);
  });

  it("keeps a reported zero token count", async () => {
    deps = metered([TRIAGE, OK_BLOCK], { input: 0, output: 0 });
    await prepare(deps, POLICY, REQUEST);

    expect(record("acceptance.json").calls?.[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("records both attempts of a retried site, and the deciding one keeps the site duration", async () => {
    // The replaced attempt is made measurably slower, so `durations` cannot equal both answers by
    // rounding and the assertion below can actually fail (#533).
    const replies = [TRIAGE, MALFORMED_BLOCK, OK_BLOCK];
    let served = 0;
    deps = {
      ...depsWith([]),
      agent: async () => {
        served += 1;
        const text = replies[served - 1] ?? "";
        if (served === 2) await new Promise((resolve) => setTimeout(resolve, 8));
        return { text, costUsd: 0.02, turns: 1, inputTokens: 1, outputTokens: 1 };
      },
    };
    await prepare(deps, POLICY, REQUEST);

    const decided = record("acceptance.json");
    const verifier = (decided.calls ?? []).filter((c) => c.site === "verifier");
    expect(verifier.map((c) => c.attempt)).toEqual([1, 2]);
    // A retry must not overwrite the attempt it replaced, and `durations` still names the one
    // that decided the site.
    // The two attempts cannot tie any more, so a regression that kept the replaced attempt's
    // duration fails here instead of passing silently.
    expect(verifier[0]?.durationMs).not.toBe(verifier[1]?.durationMs);
    expect(decided.durations?.verifier).toBe(verifier[1]?.durationMs);
  });
});

describe("prepare — the rows the verifier reads (#516)", () => {
  // A pipeline row, written the only way a Markdown table allows: escaped in the cell.
  const PIPE_TRIAGE = `## Claim checks
row 1: The fold happens
command: grep -n fold src/x.ts | head -1
observed: 3:fold
verdict: true

## Definition of Done
1. Fold exists — proven by a test

## Verdict
\`run\`

KIND: code-fix
`;
  const PIPE_BLOCK = `\`\`\`json
[{"row":1,"verdict":"match","evidence":"3:fold","command":"grep -n fold src/x.ts | head -1","exit":0}]
\`\`\`

could-not-run: none

\`\`\`json
[{"criterion":1,"verdict":"match","evidence":"ok"}]
\`\`\`
`;

  it("hands the verifier the command it will run, not the table's escape", async () => {
    const s = scripted([PIPE_TRIAGE, PIPE_BLOCK]);
    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    const verifierPrompt = s.prompts[1] ?? "";
    expect(verifierPrompt).toContain("command: grep -n fold src/x.ts | head -1");
    // The escaped cell is nowhere in the prompt; the document's own `\|` dialect note is not a row.
    expect(verifierPrompt).not.toContain("grep -n fold src/x.ts \\|");
    // The verifier copied the command it was shown, and that is the command the gate judged.
    expect(outcome).toMatchObject({ ok: true });
  });

  it("tells the verifier to copy the command byte-for-byte, quoting included (#536)", async () => {
    const s = scripted([PIPE_TRIAGE, PIPE_BLOCK]);
    await prepare(s.deps, POLICY, REQUEST);

    const verifierPrompt = s.prompts[1] ?? "";
    expect(verifierPrompt).toContain("byte-for-byte");
    expect(verifierPrompt).toContain("quote characters");
  });

  it("names the forms the could-not-run line accepts (#518)", async () => {
    const s = scripted([PIPE_TRIAGE, PIPE_BLOCK]);
    await prepare(s.deps, POLICY, REQUEST);

    const verifierPrompt = s.prompts[1] ?? "";
    expect(verifierPrompt).toContain("could-not-run: none");
    expect(verifierPrompt).toContain("could-not-run: row 5");
    expect(verifierPrompt).toContain("could-not-run: rows 5, 7");
    // The parser accepts "and" too, so the prompt has to name it (#518).
    expect(verifierPrompt).toContain("could-not-run: rows 5 and 7");
  });
});

describe("prepare — a claim command that kept its delimiters (#520)", () => {
  // Two spans in one cell: unwrap leaves one pair, so the shell would substitute the text.
  const TWO_SPANS = TRIAGE.replace(
    "command: sed -n '66,85p' src/supervisor/finalization.ts",
    "command: `git log -1`; `git show abc123`",
  );

  it("refuses before the verifier is paid for, naming the row and the fault", async () => {
    const s = scripted([TWO_SPANS]);
    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(s.calls()).toBe(1); // triage only: the verifier was never asked
    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    const detail = outcome && "detail" in outcome ? outcome.detail : "";
    expect(detail).toContain("row 1");
    expect(detail).toContain("backtick");
    expect(detail).toContain("the verifier was not asked to run it");
  });

  it("leaves a single-span command alone, so a legitimate row still reaches the verifier", async () => {
    const s = scripted([TRIAGE, OK_BLOCK]);
    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(s.calls()).toBe(2);
    expect(outcome).toMatchObject({ ok: true });
  });

  it("leaves an unset variable on the repair path it was given (#401)", async () => {
    const s = scripted([DIALECT_TRIAGE, COULD_NOT_RUN_BLOCK(2)]);
    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    // The verifier ran: the variable fault is not this check's business.
    expect(s.prompts[1] ?? "").toContain("CLAIM ROWS");
    expect(outcome).toMatchObject({ ok: false });
  });
});

describe("prepare — the re-verification reads the same blocks (#524)", () => {
  // A piped command, the shape that a table cannot hold without escaping its separator.
  const PIPE_TRIAGE = TRIAGE.replace(
    "`sed -n '66,85p' src/supervisor/finalization.ts`",
    "`grep -n fold src/x.ts | head -1`",
  );
  const PIPE_REPAIR = REPAIR(
    JSON.stringify({ row: 1, command: "grep -n fold src/x.ts | sed -n 1p", observed: "3:fold" }),
  );

  it("hands the re-verification blocks, not a table", async () => {
    const s = scripted([
      PIPE_TRIAGE,
      VERDICT_BLOCK("mismatch", "match"),
      PIPE_REPAIR,
      REVERIFY(
        '{"row":1,"verdict":"match","evidence":"3:fold"}',
        "grep -n fold src/x.ts | sed -n 1p",
      ),
    ]);
    await prepare(s.deps, POLICY, REQUEST);

    const reverifyPrompt = s.prompts[3] ?? "";
    // The prompt document describes blocks, so the payload is blocks, numbered from one.
    expect(reverifyPrompt).toContain("row 1: ");
    expect(reverifyPrompt).toContain("command: grep -n fold src/x.ts | sed -n 1p");
    expect(reverifyPrompt).not.toContain("| claim | command |");
  });
});

describe("prepare — progress lines (#539)", () => {
  const lines = (s: { deps: Parameters<typeof prepare>[0] }) => {
    const drawn: string[] = [];
    return {
      deps: { ...s.deps, out: (line: string) => drawn.push(line) },
      drawn,
    };
  };
  const attempts = (drawn: string[]) => drawn.filter((line) => line.includes(" attempt "));

  it("narrates every step with its timing, in the order it happened", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH]);
    const { deps: withOut, drawn } = lines(s);

    await prepare(withOut, POLICY, REQUEST);

    expect(drawn[0]).toBe("42: start");
    expect(drawn[1]).toMatch(/^clone \d+ms$/);
    expect(drawn).toContainEqual("triage:");
    expect(drawn.some((l) => /^  turn 1 at 0s$/.test(l))).toBe(true);
    expect(drawn.some((l) => /^  bash 7ms · ls$/.test(l))).toBe(true);
    expect(drawn.some((l) => /^triage attempt 1: \d+\.\ds, turns 1, \$0\.0100$/.test(l))).toBe(
      true,
    );
    expect(drawn.some((l) => /^verifier attempt 1: \d+\.\ds/.test(l))).toBe(true);
    expect(drawn.some((l) => /^42: evidence written in \d+ms$/.test(l))).toBe(true);
    expect(drawn.at(-1)).toMatch(/^42: verifier-mismatch after \d+ms$/);
  });

  it("draws a line for a retried attempt, numbered apart", async () => {
    // The first call throws, so triage is paid for twice (#374, #403).
    const s = scripted([TRIAGE, DOD_MISMATCH], [1]);
    const { deps: withOut, drawn } = lines(s);

    await prepare(withOut, POLICY, REQUEST);

    expect(attempts(drawn)[0]).toMatch(/^triage attempt 1: /);
    expect(attempts(drawn)[1]).toMatch(/^triage attempt 2: /);
  });

  it("draws no attempt line for a site it never reached", async () => {
    // Both triage attempts throw, so no verifier is ever called.
    const s = scripted([], [1, 2]);
    const { deps: withOut, drawn } = lines(s);

    const [outcome] = await prepare(withOut, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false });
    expect(attempts(drawn)).toHaveLength(2);
    expect(attempts(drawn).every((line) => line.startsWith("triage attempt "))).toBe(true);
  });

  it("stays silent when the caller gives it nowhere to print", async () => {
    const s = scripted([TRIAGE, DOD_MISMATCH]);

    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "verifier-mismatch" });
  });
});

describe("prepare — a prose could-not-run line is unverifiable (#533)", () => {
  const PROSE_BLOCK = [
    "```json",
    `[${ROW_JSON(1, "match", "seen")},${ROW_JSON(2, "match", "seen")}]`,
    "```",
    "",
    "could-not-run: none of the rows could run",
    "",
    "```json",
    `[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"match","evidence":"ok"}]`,
    "```",
  ].join("\n");

  it("refuses with the code, not just a thrown parse", async () => {
    const s = scripted([TRIAGE, PROSE_BLOCK, PROSE_BLOCK]);
    const [outcome] = await prepare(s.deps, POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "unverifiable" });
    expect(outcome && "detail" in outcome ? outcome.detail : "").toContain("names no row");
  });
});

describe("prepare — an outcome that paid for nothing (#526)", () => {
  it("carries no calls field when another prepare holds the lock", async () => {
    // A live holder, so the lock is refused rather than taken: nothing is paid for.
    const lockPath = join(cwd, "mypi-tasks/000-batches/b7/locks/42.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);

    const [outcome] = await prepare(depsWith([]), POLICY, REQUEST);

    expect(outcome).toMatchObject({ ok: false, code: "already-prepared" });
    // Absent is not zero: nothing was paid for, so there is no telemetry list at all.
    expect(outcome && "calls" in outcome).toBe(false);
  });
});
