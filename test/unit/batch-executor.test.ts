import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExecutorDeps, type Herdr, runBatch } from "../../src/batch/executor";
import { buildManifestText } from "../../src/batch/manifest";
import type { BatchPolicy } from "../../src/batch/policy";
import type { BatchRequest } from "../../src/batch/request";
import { RUN_DISCLAIMER, type Tracker } from "../../src/batch/tracker";

const POLICY: BatchPolicy = {
  prepare: {
    kinds: ["code-fix"],
    kindTemplates: { "code-fix": "templates/batch-code-fix.yaml" },
    triageModel: "a/b",
    verifierModel: "c/d",
    agentTimeoutMinutes: 5,
  },
  run: { timeoutMinutes: 5 },
};
const REQUEST: BatchRequest = { id: "b9", tickets: [164, 165] };
const TEMPLATE = readFileSync("templates/batch-code-fix.yaml", "utf8");

let root: string;
let worktrees: string;
let created: string[];
let closed: string[];
let commands: string[];
let trackerOps: {
  op: string;
  n?: number;
  label?: string;
  text?: string;
  marker?: string;
  disclaimer?: string;
}[];

/** Records every tracker call so a test can assert the exact writeback sequence. */
function fakeTracker(): Tracker {
  return {
    view: async () => ({
      number: 0,
      title: "",
      body: "",
      state: "OPEN",
      updatedAt: "",
      labels: [],
      comments: [],
    }),
    upsertMarkerComment: async (n, marker, text, disclaimer) => {
      trackerOps.push({ op: "comment", n, text, marker, disclaimer });
      return { action: "created", id: 1 };
    },
    addLabel: async (_n, label) => {
      trackerOps.push({ op: "add", label });
    },
    removeLabel: async (_n, label) => {
      trackerOps.push({ op: "remove", label });
    },
  };
}

function manifestFor(ticket: number): string {
  return buildManifestText({
    templateText: TEMPLATE,
    ask: { title: `t${ticket}`, description: "d", definition_of_done: ["one criterion"] },
    sessionId: `b-b9-t${ticket}`,
  });
}

/** A herdr whose run writes `final.md` on the first poll and is gone by the third. */
function fakeHerdr(behaviour: {
  final?: { status: string; exitCode: number } | undefined;
  startRun?: boolean;
  vanish?: boolean;
  throwOnRun?: boolean;
}): Herdr {
  return {
    async createWorkspace({ cwd }) {
      created.push(cwd);
      const id = `w${created.length}`;
      return { workspaceId: id, paneId: `${id}:p1` };
    },
    async runInPane(paneId, command) {
      commands.push(`${paneId} ${command}`);
      if (behaviour.throwOnRun === true) throw new Error("pane refused the command");
      const slug = command.match(/mypi-multi-agent (b-[^"]+)"/)?.[1] ?? "";
      if (behaviour.startRun === true) {
        // The runtime creates run-details/ at start, before any verdict exists.
        const dir = join(worktrees, slug, "mypi-tasks", slug, "run-details");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "conversation.jsonl"), "{}\n");
      }
      if (behaviour.final === undefined) return;
      const dir = join(worktrees, slug, "mypi-tasks", slug, "run-details");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "final.md"),
        `---\nstatus: ${behaviour.final.status}\nexit_code: ${behaviour.final.exitCode}\ntotal_cost_usd: 0.5\ntotal_tokens: 3958699\n---\n\nbody\n`,
      );
      writeFileSync(join(dir, "scorecard.json"), "{}\n");
      writeFileSync(join(dir, "plan.md"), "# plan\n");
      writeFileSync(join(dir, "conversation.jsonl"), "{}\n");
    },
    async workspaceExists() {
      return behaviour.vanish !== true;
    },
    async closeWorkspace(id) {
      closed.push(id);
    },
  };
}

function deps(herdr: Herdr, overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    repoRoot: root,
    taskDir: "mypi-tasks",
    policy: POLICY,
    herdr,
    tracker: fakeTracker(),
    preflight: async (slugs) => slugs.map((slug) => ({ slug, ok: true })),
    createWorktree: async ({ slug }) => {
      const path = join(worktrees, slug);
      mkdirSync(path, { recursive: true });
      return { path };
    },
    // Hermetic by default: the real removal shells out to git, and these worktrees live
    // in a tmp dir that is not a repository. The removal tests inject their own.
    removeWorktree: async () => {},
    sleep: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mypi-exec-"));
  worktrees = mkdtempSync(join(tmpdir(), "mypi-wt-"));
  created = [];
  closed = [];
  commands = [];
  trackerOps = [];
  for (const ticket of REQUEST.tickets) {
    const dir = join(root, "mypi-tasks/000-batches", REQUEST.id, "tickets", String(ticket));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.yaml"), manifestFor(ticket));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
});

describe("runBatch", () => {
  it("runs both tickets, records each outcome, and closes both workspaces", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes.map((o) => o.code)).toEqual(["success", "success"]);
    expect(created).toHaveLength(2);
    expect(closed).toHaveLength(2);
    expect(commands[0]).toContain('pi "/mypi-multi-agent b-b9-t164"');

    const record = join(root, "mypi-tasks/000-batches/b9/tickets/164");
    const run = JSON.parse(readFileSync(join(record, "run.json"), "utf8")) as {
      code: string;
      exitCode: number;
    };
    expect(run).toMatchObject({ code: "success", exitCode: 0 });
    // The record holds only decisions: run.json and no copied run artifacts.
    expect(existsSync(join(record, "final.md"))).toBe(false);
    expect(existsSync(join(record, "scorecard.json"))).toBe(false);
    // The whole run-details/ moved to the checkout task dir, beside the manifest.
    const checkout = join(root, "mypi-tasks/b-b9-t164/run-details");
    expect(readFileSync(join(checkout, "final.md"), "utf8")).toContain("status: success");
    expect(readFileSync(join(checkout, "scorecard.json"), "utf8")).toBe("{}\n");
  });

  it("writes the run outcome back to the ticket on success, and hands it to a human", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })), {
      id: "b9",
      tickets: [164],
    });

    // Tracker has no close/reopen/state method, so this exact sequence also proves the
    // executor never closes the ticket.
    expect(trackerOps.map((o) => o.op)).toEqual(["comment", "remove", "add"]);
    expect(trackerOps[1]?.label).toBe("ready-for-agent");
    expect(trackerOps[2]?.label).toBe("ready-for-human");
    // The run marker is distinct from prepare's, so it never edits the DoD comment.
    expect(trackerOps[0]?.marker).toBe("<!-- mypi-batch:b9:164:run -->");
    // The run comment is not triage, so it carries the run disclaimer.
    expect(trackerOps[0]?.disclaimer).toBe(RUN_DISCLAIMER);
    const text = trackerOps[0]?.text ?? "";
    expect(text).toContain("outcome: success");
    expect(text).toContain("branch: task/b-b9-t164");
    expect(text).toContain("duration:");
    expect(text).toContain("mypi-tasks/000-batches/b9/tickets/164");
  });

  it("writes the failure back to the ticket and keeps ready-for-agent", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })), {
      id: "b9",
      tickets: [164],
    });

    expect(trackerOps.map((o) => o.op)).toEqual(["comment"]);
    const text = trackerOps[0]?.text ?? "";
    expect(text).toContain("outcome: failure");
    expect(text).toContain("detail: status failure");
  });

  it("copies the whole run-details to the checkout task dir, then removes the worktree", async () => {
    const remove = async ({ slug }: { slug: string }) => {
      rmSync(join(worktrees, slug), { recursive: true, force: true });
    };
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), { removeWorktree: remove }),
      { id: "b9", tickets: [164] },
    );

    const dir = join(root, "mypi-tasks/b-b9-t164/run-details");
    expect(existsSync(join(dir, "plan.md"))).toBe(true);
    expect(existsSync(join(dir, "conversation.jsonl"))).toBe(true);
    expect(readFileSync(join(dir, "scorecard.json"), "utf8")).toBe("{}\n");
    // The worktree is gone; the copy is the surviving evidence.
    expect(existsSync(join(worktrees, "b-b9-t164"))).toBe(false);
  });

  it("writes the checkout task dir's session.yaml when the run starts", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })), {
      id: "b9",
      tickets: [164],
    });

    const dir = join(root, "mypi-tasks/b-b9-t164");
    expect(existsSync(join(dir, "session.yaml"))).toBe(true);
    expect(existsSync(join(dir, "run-details/final.md"))).toBe(true);
  });

  it("leaves both the worktree and the checkout copy for a failed run", async () => {
    const remove = async ({ slug }: { slug: string }) => {
      rmSync(join(worktrees, slug), { recursive: true, force: true });
    };
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } }), { removeWorktree: remove }),
      { id: "b9", tickets: [164] },
    );

    expect(outcomes[0]?.code).toBe("failure");
    // The halted ticket's worktree and its checkout copy both stay.
    expect(existsSync(join(worktrees, "b-b9-t164"))).toBe(true);
    expect(existsSync(join(root, "mypi-tasks/b-b9-t164/run-details/final.md"))).toBe(true);
  });

  it("removes the worktree of a successful ticket and keeps it for a failed one", async () => {
    const removed: string[] = [];
    const remove = async ({ slug }: { slug: string }) => {
      removed.push(slug);
    };

    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), { removeWorktree: remove }),
      REQUEST,
    );
    expect(removed).toEqual(["b-b9-t164", "b-b9-t165"]);

    removed.length = 0;
    await runBatch(
      deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } }), { removeWorktree: remove }),
      REQUEST,
    );
    // The halted ticket's checkout is the thing someone has to look at.
    expect(removed).toEqual([]);
  });

  it("removes nothing when the run failed to start", async () => {
    const removed: string[] = [];
    await runBatch(
      deps(fakeHerdr({ vanish: true }), {
        removeWorktree: async ({ slug }) => {
          removed.push(slug);
        },
      }),
      REQUEST,
    );
    expect(removed).toEqual([]);
  });

  it("commits the worktree before removing it on success", async () => {
    const order: string[] = [];
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        commitWorktree: async ({ slug }) => {
          order.push(`commit:${slug}`);
        },
        removeWorktree: async ({ slug }) => {
          order.push(`remove:${slug}`);
        },
      }),
      { id: "b9", tickets: [164] },
    );

    expect(outcomes[0]?.code).toBe("success");
    expect(order).toEqual(["commit:b-b9-t164", "remove:b-b9-t164"]);
  });

  it("turns a commit failure into a failed run that keeps the worktree", async () => {
    const removed: string[] = [];
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        commitWorktree: async () => {
          throw new Error("git commit refused");
        },
        removeWorktree: async ({ slug }) => {
          removed.push(slug);
        },
      }),
      { id: "b9", tickets: [164] },
    );

    expect(outcomes[0]?.code).toBe("failure");
    expect(outcomes[0]?.detail).toContain("commit failed");
    expect(removed).toEqual([]);
    expect(closed).toEqual(["w1"]);
  });

  it("refuses a task dir that already holds a run's final.md, before spending", async () => {
    // Spec #177: run refuses a task dir that already has run-details/final.md.
    const slug = "b-b9-t164";
    const stale = join(worktrees, slug, "mypi-tasks", slug, "run-details");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "final.md"), "---\nstatus: success\nexit_code: 0\n---\n");
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes[0]).toMatchObject({ code: "failure", ticket: 164 });
    expect(outcomes[0]?.detail).toContain("already has a run");
    expect(created).toHaveLength(0);
    expect(commands).toHaveLength(0);
  });

  it("never reads a final.md written before the launch as this run's verdict", async () => {
    // A stub placed before the run must not answer for it: the poll only accepts a
    // file written after the launch, so this run times out instead of reporting success.
    const herdr = fakeHerdr({ final: undefined });
    const withStale: Herdr = {
      ...herdr,
      async createWorkspace(args) {
        const slug = "b-b9-t164";
        const dir = join(worktrees, slug, "mypi-tasks", slug, "run-details");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, "final.md");
        writeFileSync(path, "---\nstatus: success\nexit_code: 0\n---\n");
        utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
        return herdr.createWorkspace(args);
      },
    };
    // A clock that moves a minute per tick, so the poll reaches its 5-minute bound at once.
    let clock = Date.now();
    const outcomes = await runBatch(deps(withStale, { now: () => (clock += 60_000) }), {
      id: "b9",
      tickets: [164],
    });

    expect(outcomes[0]?.code).toBe("timeout");
  });

  it("writes a batch summary a human can read, and one that parses", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })), REQUEST);

    const summary = JSON.parse(
      readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.json"), "utf8"),
    ) as {
      id: string;
      outcomes: { code: string }[];
    };
    expect(summary.id).toBe("b9");
    expect(summary.outcomes.map((o) => o.code)).toEqual(["success", "success"]);

    const text = readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.md"), "utf8");
    expect(text).toContain("2 of 2 succeeded.");
    expect(text).toContain("| 164 |");
  });

  it("reports each run's cost and the batch total in the summary", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes[0]?.costUsd).toBe(0.5);
    expect(outcomes[1]?.costUsd).toBe(0.5);

    const summary = JSON.parse(
      readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.json"), "utf8"),
    ) as { totalCostUsd: number; outcomes: { costUsd?: number }[] };
    expect(summary.totalCostUsd).toBe(1);
    expect(summary.outcomes[0]?.costUsd).toBe(0.5);

    const text = readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.md"), "utf8");
    expect(text).toContain("$0.5");
    expect(text).toContain("cost: $1");
  });

  it("reports a halted ticket's cost as empty, not zero", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })), REQUEST);

    const summary = JSON.parse(
      readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.json"), "utf8"),
    ) as { outcomes: { code: string; costUsd?: number }[] };
    const haltedOutcome = summary.outcomes[1];
    expect(haltedOutcome?.code).toBe("batch-halted");
    expect(haltedOutcome).not.toHaveProperty("costUsd");

    const text = readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.md"), "utf8");
    const haltedRow = text.split("\n").find((line) => line.startsWith("| 165 |"));
    const cells = (haltedRow ?? "").split("|");
    expect(cells[4]?.trim() ?? "").toBe("");
  });

  it("records where a halted batch stopped", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })), REQUEST);

    const text = readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.md"), "utf8");
    expect(text).toContain("0 of 2 succeeded; the batch halted at #164");
    expect(text).toContain("batch-halted");
  });

  it("halts on the first failure and marks the rest batch-halted", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })),
      REQUEST,
    );

    expect(outcomes).toEqual([
      expect.objectContaining({ ticket: 164, code: "failure", exitCode: 1 }),
      { ticket: 165, code: "batch-halted" },
    ]);
    expect(created).toHaveLength(1);
    // The workspace of a failed run is closed too.
    expect(closed).toEqual(["w1"]);
  });

  it("times out with the workspace closed when final.md never appears", async () => {
    // The run started (run-details/ exists) but never wrote a verdict: a genuine timeout.
    let clock = 0;
    const outcomes = await runBatch(
      deps(fakeHerdr({ startRun: true }), { now: () => (clock += 60_000) }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 5 },
    );

    expect(outcomes[0]).toMatchObject({ code: "timeout" });
    expect(closed).toEqual(["w1"]);
  });

  it("fails fast as startup-failed when the run never creates run-details/", async () => {
    // A run that never starts: pi exits before the runtime creates run-details/ (#285).
    // The grace deadline bounds the poll far short of the 5-minute timeout.
    let nowMs = 0;
    let polls = 0;
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: undefined }), {
        now: () => nowMs,
        sleep: async () => {
          polls += 1;
          nowMs += 60_000;
        },
      }),
      { id: "b9", tickets: [164] },
    );

    expect(outcomes[0]).toMatchObject({
      code: "startup-failed",
      detail: "run never created run-details/",
    });
    expect(closed).toEqual(["w1"]);
    expect(polls).toBeLessThan(5);
  });

  it("refuses an invalid manifest without creating a worktree or a workspace", async () => {
    writeFileSync(
      join(root, "mypi-tasks/000-batches/b9/tickets/164/manifest.yaml"),
      "version: '1.2'\nsession: {}\nagents: []\n",
    );

    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes).toEqual([
      expect.objectContaining({ ticket: 164, code: "manifest-invalid" }),
      { ticket: 165, code: "batch-halted" },
    ]);
    expect(created).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("refuses a model the registry cannot resolve, before anything is created", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        preflight: async (slugs) => slugs.map((slug) => ({ slug, ok: false })),
      }),
      { id: "b9", tickets: [164] },
    );

    expect(outcomes[0]).toMatchObject({ code: "model-unavailable" });
    expect(created).toEqual([]);
  });

  it("reports a vanished workspace as startup-failed and still closes", async () => {
    const outcomes = await runBatch(deps(fakeHerdr({ vanish: true })), {
      id: "b9",
      tickets: [164],
    });

    expect(outcomes[0]).toMatchObject({ code: "startup-failed", detail: "workspace disappeared" });
    expect(closed).toEqual(["w1"]);
  });

  it("closes the workspace when the pane refuses the command", async () => {
    const outcomes = await runBatch(deps(fakeHerdr({ throwOnRun: true })), {
      id: "b9",
      tickets: [164],
    });

    expect(outcomes[0]).toMatchObject({
      code: "startup-failed",
      detail: "pane refused the command",
    });
    expect(closed).toEqual(["w1"]);
  });

  it("refuses a batch that already has a run record", async () => {
    mkdirSync(join(root, "mypi-tasks/000-batches/b9/tickets/164"), { recursive: true });
    writeFileSync(join(root, "mypi-tasks/000-batches/b9/tickets/164/run.json"), "{}\n");

    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes[0]).toMatchObject({
      ticket: 164,
      code: "failure",
      detail: "this batch already has run records",
    });
    expect(created).toEqual([]);
  });
});
