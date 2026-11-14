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
import {
  type ExecutorDeps,
  extensionFor,
  type Herdr,
  runBatch,
  supervisorCommandFor,
} from "../../src/batch/executor";
import { buildManifestText } from "../../src/batch/manifest";
import { type BatchPolicy, DEFAULT_LABELS } from "../../src/batch/policy";
import type { BatchRequest } from "../../src/batch/request";
import { sandboxAvailable } from "../../src/batch/sandbox";
import { RUN_DISCLAIMER, type Tracker } from "../../src/batch/tracker";
import { withNoSandbox } from "../helpers/sandbox";

const POLICY: BatchPolicy = {
  prepare: {
    kinds: ["code-fix"],
    kindTemplates: { "code-fix": "templates/batch-code-fix.yaml" },
    triageModel: "a/b",
    verifierModel: "c/d",
    agentTimeoutMinutes: 5,
    refuseBlocked: false,
  },
  run: { timeoutMinutes: 5 },
  labels: DEFAULT_LABELS,
};
const REQUEST: BatchRequest = { id: "b9", tickets: [164, 165] };
const TEMPLATE = readFileSync("templates/batch-code-fix.yaml", "utf8");

let root: string;
let worktrees: string;
let agentConfig: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
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
      blockedBy: [],
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

/** A worktree of this repo carries the entry point pi loads (#562), so the launch precondition holds. */
function plantExtension(path: string): void {
  mkdirSync(join(path, "src/pi"), { recursive: true });
  writeFileSync(join(path, "src/pi/extension.ts"), "// entry\n");
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
      plantExtension(path);
      return { path };
    },
    // Hermetic by default: the real removal shells out to git, and these worktrees live
    // in a tmp dir that is not a repository. The removal tests inject their own.
    removeWorktree: async () => {},
    // Same for the commit: the real one asks git for the branch's commit count, which a
    // tmp dir that is not a repository cannot answer.
    commitWorktree: async () => ({ commits: 1 }),
    sleep: async () => {},
    // Landing stubs: the real ones shell to git/gh, which a tmp dir that is not a repo cannot do.
    createBatchBranch: async () => {},
    advanceBatchBranch: async () => {},
    openPR: async () => {},
    mergePR: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mypi-exec-"));
  worktrees = mkdtempSync(join(tmpdir(), "mypi-wt-"));
  // Unconfined on Linux, a run relies on the operator's registered extension; the test states one
  // so the launch precondition holds on every platform (#563).
  agentConfig = mkdtempSync(join(tmpdir(), "mypi-exec-agent-"));
  writeFileSync(join(agentConfig, "extension.ts"), "// entry\n");
  writeFileSync(
    join(agentConfig, "settings.json"),
    JSON.stringify({ extensions: [join(agentConfig, "extension.ts")] }),
  );
  process.env.PI_CODING_AGENT_DIR = agentConfig;
  // A real repo always carries this; a launch is refused without it (#563).
  writeFileSync(join(root, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");
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
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(agentConfig, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
});

describe("runBatch", () => {
  it("refuses before a workspace exists when the project config is missing (#563)", async () => {
    rmSync(join(root, "mypi-multi-agent.yaml"));

    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes[0]).toMatchObject({ code: "startup-failed" });
    expect(outcomes[0]?.detail).toContain("mypi-multi-agent.yaml");
    expect(created).toEqual([]);
  });

  it("records an unconfined run as unconfined when the sandbox is forced off (#492)", async () => {
    const outcomes = await withNoSandbox("1", () =>
      runBatch(deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })), REQUEST),
    );

    expect(outcomes).toHaveLength(2);
    const record = join(root, "mypi-tasks/000-batches/b9/tickets/164", "run.json");
    const run = JSON.parse(readFileSync(record, "utf8")) as { code: string; sandboxed: boolean };
    expect(run).toMatchObject({ code: "success", sandboxed: false });
  });

  it("runs both tickets, records each outcome, and closes both workspaces", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes.map((o) => o.code)).toEqual(["success", "success"]);
    expect(created).toHaveLength(2);
    expect(closed).toHaveLength(2);
    expect(commands[0]).toContain('"/mypi-multi-agent b-b9-t164"');

    const record = join(root, "mypi-tasks/000-batches/b9/tickets/164");
    const run = JSON.parse(readFileSync(join(record, "run.json"), "utf8")) as {
      code: string;
      exitCode: number;
    };
    expect(run).toMatchObject({ code: "success", exitCode: 0 });
    // A record must say whether the agents ran confined: nothing else in it hints at that (#492).
    expect(run).toMatchObject({ sandboxed: sandboxAvailable() });
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

  it("refuses a success whose branch carries no commits (#289)", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        commitWorktree: async () => ({ commits: 0 }),
      }),
      { id: "b9", tickets: [164] },
    );

    expect(outcomes[0]).toMatchObject({
      code: "failure",
      detail: "no commits on task/b-b9-t164: the run left the branch empty",
    });
    // The worktree is the thing someone has to look at, so it stays.
    expect(existsSync(join(worktrees, "b-b9-t164"))).toBe(true);
  });

  it("keeps the run's cost and duration in the record when the commit fails (#299)", async () => {
    let clock = 0;
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        now: () => (clock += 60_000),
        commitWorktree: async () => {
          throw new Error("index locked");
        },
      }),
      { id: "b9", tickets: [164] },
    );

    const run = JSON.parse(
      readFileSync(join(root, "mypi-tasks/000-batches/b9/tickets/164/run.json"), "utf8"),
    ) as { code: string; detail: string; costUsd?: number; durationMs?: number };
    // The failure path is the one a human reads: the final.md numbers survive the remap.
    expect(run).toMatchObject({
      code: "failure",
      detail: "commit failed: index locked",
      costUsd: 0.5,
    });
    expect(run.durationMs).toBeGreaterThan(0);
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
          return { commits: 1 };
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
    // The stale ticket is refused without spending; the unrelated ticket still runs.
    expect(outcomes[1]).toMatchObject({ code: "success", ticket: 165 });
    expect(created).toHaveLength(1);
    expect(commands).toHaveLength(1);
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
    expect(text).toContain("| 164    |");
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

  it("reports a dependency-failed ticket's cost as empty, not zero", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })), {
      id: "b9",
      tickets: [164, 165],
      dependsOn: { 165: 164 },
    });

    const summary = JSON.parse(
      readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.json"), "utf8"),
    ) as { outcomes: { code: string; costUsd?: number }[] };
    const blocked = summary.outcomes[1];
    expect(blocked?.code).toBe("dependency-failed");
    expect(blocked).not.toHaveProperty("costUsd");

    const text = readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.md"), "utf8");
    const blockedRow = text.split("\n").find((line) => line.split("|")[1]?.trim() === "165");
    const cells = (blockedRow ?? "").split("|");
    expect(cells[4]?.trim() ?? "").toBe("");
  });

  it("names dependency-failed in the summary verdict", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })), {
      id: "b9",
      tickets: [164, 165],
      dependsOn: { 165: 164 },
    });

    const text = readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.md"), "utf8");
    expect(text).toContain("0 of 2 succeeded; 2 did not (1 dependency-failed)");
    expect(text).toContain("dependency-failed");
  });

  it("does not block an unrelated ticket when one fails", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })),
      REQUEST,
    );

    expect(outcomes).toEqual([
      expect.objectContaining({ ticket: 164, code: "failure", exitCode: 1 }),
      expect.objectContaining({ ticket: 165, code: "failure", exitCode: 1 }),
    ]);
    // Both tickets ran; the failure closed its workspace and did not halt the sibling.
    expect(created).toHaveLength(2);
    expect(closed).toEqual(["w1", "w2"]);
  });

  it("runs a dependent after its dependency and bases its branch on the dependency", async () => {
    const bases: (string | undefined)[] = [];
    const commitBases: (string | undefined)[] = [];
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        createWorktree: async ({ slug, base }) => {
          bases.push(base);
          const path = join(worktrees, slug);
          plantExtension(path);
          return { path };
        },
        commitWorktree: async ({ base }) => {
          commitBases.push(base);
          return { commits: 1 };
        },
      }),
      { id: "b9", tickets: [165, 164], dependsOn: { 165: 164 } },
      { land: "pr" },
    );

    // The request listed 165 first; the dependency reordered it after 164.
    expect(commands[0]).toContain('"/mypi-multi-agent b-b9-t164"');
    expect(commands[1]).toContain('"/mypi-multi-agent b-b9-t165"');
    // The dependent's worktree and empty-branch check run against the dependency's branch.
    expect(bases).toEqual([undefined, "task/b-b9-t164"]);
    expect(commitBases).toEqual([undefined, "task/b-b9-t164"]);
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
      attempts: 2,
    });
    // D12: the first start failure is retried, so both workspaces close (#306).
    expect(closed).toEqual(["w1", "w2"]);
    expect(polls).toBeLessThan(10);
  });

  it("scales the startup grace to the run's own budget (#299)", async () => {
    // The grace is a tenth of the timeout, capped at a minute: a one-minute run cannot
    // afford to spend sixty seconds of it waiting for a pane that will never start.
    let nowMs = 0;
    let polls = 0;
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: undefined }), {
        now: () => nowMs,
        sleep: async () => {
          polls += 1;
          nowMs += 5_000;
        },
      }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );

    expect(outcomes[0]).toMatchObject({ code: "startup-failed", attempts: 2 });
    // 6 s of grace at a 5 s poll is two polls per attempt; 60 s would be twelve, and the
    // timeout is twelve, so a retry that ignored the budget would show up here.
    expect(polls).toBeLessThanOrEqual(4);
  });

  it("records a prepare refusal and still runs an unrelated later ticket", async () => {
    rmSync(join(root, "mypi-tasks/000-batches/b9/tickets/164/manifest.yaml"));
    writeFileSync(
      join(root, "mypi-tasks/000-batches/b9/tickets/164/refusal.json"),
      JSON.stringify({ code: "dod-rejected", detail: "threshold not reachable" }),
    );

    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      REQUEST,
    );

    expect(outcomes.map((o) => o.code)).toEqual(["prepare-refused", "success"]);
    expect(created).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      ticket: 164,
      detail: "dod-rejected: threshold not reachable",
    });
  });

  it("blocks a dependent ticket after a prepare refusal", async () => {
    rmSync(join(root, "mypi-tasks/000-batches/b9/tickets/164/manifest.yaml"));
    writeFileSync(
      join(root, "mypi-tasks/000-batches/b9/tickets/164/refusal.json"),
      JSON.stringify({ code: "dod-rejected", detail: "no reachable fix" }),
    );

    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })),
      { id: "b9", tickets: [164, 165], dependsOn: { 165: 164 } },
    );

    expect(outcomes).toEqual([
      expect.objectContaining({ ticket: 164, code: "prepare-refused" }),
      expect.objectContaining({
        ticket: 165,
        code: "dependency-failed",
        detail: "dependency #164 did not succeed (prepare-refused)",
      }),
    ]);
    expect(created).toEqual([]);
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

    expect(outcomes[0]).toMatchObject({
      code: "startup-failed",
      detail: "workspace disappeared",
      attempts: 2,
    });
    expect(closed).toEqual(["w1", "w2"]);
  });

  it("closes the workspace when the pane refuses the command", async () => {
    const outcomes = await runBatch(deps(fakeHerdr({ throwOnRun: true })), {
      id: "b9",
      tickets: [164],
    });

    expect(outcomes[0]).toMatchObject({
      code: "startup-failed",
      detail: "pane refused the command",
      attempts: 2,
    });
    // Both attempts create a workspace, and both are closed.
    expect(closed).toEqual(["w1", "w2"]);
  });

  it("retries a start failure once, and reports success when the relaunch starts (#306)", async () => {
    const inner = fakeHerdr({ final: { status: "success", exitCode: 0 } });
    let launches = 0;
    const flaky: Herdr = {
      ...inner,
      async createWorkspace(args) {
        launches += 1;
        return inner.createWorkspace(args);
      },
      async runInPane(paneId, command) {
        // The first pane dies before the runtime starts; the relaunch is the real one.
        if (launches === 1) throw new Error("pane refused the command");
        return inner.runInPane(paneId, command);
      },
    };

    const outcomes = await runBatch(deps(flaky), { id: "b9", tickets: [164] });

    expect(outcomes[0]).toMatchObject({ code: "success", exitCode: 0, attempts: 2 });
    // One launch per attempt, and the failed attempt's workspace is closed too.
    expect(created).toHaveLength(2);
    expect(closed).toEqual(["w1", "w2"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('mypi-multi-agent b-b9-t164"');
  });

  it("retries a dead start once per ticket, not as a ladder (#306)", async () => {
    const inner = fakeHerdr({ throwOnRun: true });
    let launches = 0;
    const dead: Herdr = {
      ...inner,
      async createWorkspace(args) {
        launches += 1;
        return inner.createWorkspace(args);
      },
    };

    const outcomes = await runBatch(deps(dead), REQUEST);

    expect(outcomes.map((o) => o.code)).toEqual(["startup-failed", "startup-failed"]);
    // Two launches per ticket: the retry is one, not a ladder.
    expect(launches).toBe(4);
    expect(created).toHaveLength(4);
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

  it("folds each success into the run branch and opens one PR at the end (#584)", async () => {
    const branches: string[] = [];
    const advances: [string, string][] = [];
    const prs: { branch: string; title: string }[] = [];
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        createBatchBranch: async (id) => {
          branches.push(id);
        },
        advanceBatchBranch: async (id, slug) => {
          advances.push([id, slug]);
        },
        openPR: async (branch, title) => {
          prs.push({ branch, title });
        },
      }),
      REQUEST,
    );

    expect(branches).toEqual(["b9"]);
    expect(advances).toEqual([
      ["b9", "b-b9-t164"],
      ["b9", "b-b9-t165"],
    ]);
    expect(prs).toEqual([{ branch: "batch/b9", title: "batch b9" }]);
  });

  it("opens no PR when no ticket succeeded in fold-in (#584)", async () => {
    const prs: string[] = [];
    await runBatch(
      deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } }), {
        openPR: async (branch) => {
          prs.push(branch);
        },
      }),
      { id: "b9", tickets: [164] },
    );

    expect(prs).toEqual([]);
  });

  it("opens one PR per finished ticket in --pr mode (#584)", async () => {
    const prs: string[] = [];
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        openPR: async (branch) => {
          prs.push(branch);
        },
      }),
      REQUEST,
      { land: "pr" },
    );

    expect(prs).toEqual(["task/b-b9-t164", "task/b-b9-t165"]);
  });

  it("merges each ticket PR in order in --pr --merge (#584)", async () => {
    const merges: string[] = [];
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        mergePR: async (branch) => {
          merges.push(branch);
        },
      }),
      REQUEST,
      { land: "pr", merge: true },
    );

    expect(merges).toEqual(["task/b-b9-t164", "task/b-b9-t165"]);
  });

  it("merges the run branch PR in fold-in --merge (#584)", async () => {
    const merges: string[] = [];
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        mergePR: async (branch) => {
          merges.push(branch);
        },
      }),
      { id: "b9", tickets: [164] },
      { merge: true },
    );

    expect(merges).toEqual(["batch/b9"]);
  });

  it("records land-failed and halts the rest when a fold-in advance fails (#584)", async () => {
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        advanceBatchBranch: async (_id, slug) => {
          if (slug === "b-b9-t164") throw new Error("branch gone");
        },
      }),
      REQUEST,
    );

    expect(outcomes[0]).toMatchObject({ code: "land-failed", detail: "land: branch gone" });
    expect(outcomes[1]?.code).toBe("batch-halted");
  });

  it("records a landError in the summary when the fold-in final PR fails (#584)", async () => {
    await runBatch(
      deps(fakeHerdr({ final: { status: "success", exitCode: 0 } }), {
        openPR: async () => {
          throw new Error("no gh");
        },
      }),
      { id: "b9", tickets: [164] },
    );

    const summary = JSON.parse(
      readFileSync(join(root, "mypi-tasks/000-batches/b9/summary.json"), "utf8"),
    ) as { landError?: string };
    expect(summary.landError).toBe("land: no gh");
  });
});

describe("#415: what run says while it waits", () => {
  /** A herdr that starts the run with events on disk and a supervisor waiting on a prompt. */
  function talkingHerdr(behaviour: { events: string[]; question?: string }): Herdr {
    const inner = fakeHerdr({ startRun: true });
    return {
      ...inner,
      async runInPane(paneId, command) {
        await inner.runInPane(paneId, command);
        const slug = command.match(/mypi-multi-agent (b-[^"]+)"/)?.[1] ?? "";
        writeFileSync(
          join(worktrees, slug, "mypi-tasks", slug, "run-details", "conversation.jsonl"),
          `${behaviour.events.join("\n")}\n`,
        );
      },
      async paneStatus() {
        return behaviour.question === undefined
          ? { state: "working" }
          : { state: "blocked", question: behaviour.question };
      },
    };
  }

  const register = JSON.stringify({
    type: "AGENT_REGISTER",
    sender: "implementer",
    payload: {},
    timestamp: 1,
  });
  const workOrder = JSON.stringify({
    type: "WORK_ORDER",
    sender: "supervisor",
    recipient: "implementer",
    payload: { taskId: "task-1" },
    timestamp: 2,
  });

  it("prints the start block and one line per event, then names the stall", async () => {
    const progress: string[] = [];
    let nowMs = 0;
    const outcomes = await runBatch(
      deps(
        talkingHerdr({ events: [register, workOrder], question: "This run wants to write files." }),
        {
          now: () => nowMs,
          sleep: async () => {
            nowMs += 5_000;
          },
          progress: (line) => progress.push(line),
        },
      ),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );

    const text = progress.join("\n");
    expect(text).toContain("b9  #164  b-b9-t164");
    expect(text).toContain("branch task/b-b9-t164");
    expect(text).toContain("watch: herdr pane read w1:p1");
    expect(text).toContain("implementer registered");
    expect(text).toContain("#164 ▸ supervisor → implementer: work order task-1");
    expect(text).toContain("w1:p1 is waiting for input");
    expect(text).toContain("This run wants to write files.");
    // Each event is printed once, not once per poll.
    expect(progress.filter((line) => line.includes("implementer registered"))).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ code: "supervisor-stalled" });
    expect(outcomes[0]?.detail).toContain("waiting for input in w1:p1");
  });

  it("names silence as silence, and never as a timeout", async () => {
    const progress: string[] = [];
    let nowMs = 0;
    const outcomes = await runBatch(
      deps(talkingHerdr({ events: [register] }), {
        now: () => nowMs,
        sleep: async () => {
          nowMs += 5_000;
        },
        progress: (line) => progress.push(line),
      }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );

    expect(outcomes[0]).toMatchObject({ code: "supervisor-stalled" });
    expect(outcomes[0]?.detail).toContain("no run event for");
    expect(progress.join("\n")).not.toContain("is waiting for input");
  });

  it("prints nothing at all when the caller does not listen (--quiet)", async () => {
    const progress: string[] = [];
    let nowMs = 0;
    const outcomes = await runBatch(
      deps(talkingHerdr({ events: [register], question: "This run wants to write files." }), {
        now: () => nowMs,
        sleep: async () => {
          nowMs += 5_000;
        },
      }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );

    expect(progress).toEqual([]);
    // The outcome does not depend on anybody watching.
    expect(outcomes[0]).toMatchObject({ code: "supervisor-stalled" });
  });

  it("launches the supervisor declared unattended, so nothing can ask a peer for a keystroke", async () => {
    let nowMs = 0;
    await runBatch(
      deps(fakeHerdr({ final: { status: "done", exitCode: 0 } }), {
        now: () => nowMs,
        sleep: async () => {
          nowMs += 5_000;
        },
      }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );
    // The command carries the unattended stance itself: a pane inherits no environment (#415).
    // Sandboxed, the throwaway config directory carries no extensions, so the command names the
    // worktree's own entry point; unsandboxed, the operator's config still supplies it (#548).
    expect(commands[0]).toContain('"/mypi-multi-agent b-b9-t164"');
    expect(commands[0]).toContain("MYPY_UNATTENDED=1 pi ");
    if (sandboxAvailable()) {
      expect(commands[0]).toMatch(/--extension ".*\/src\/pi\/extension\.ts"/);
    } else {
      expect(commands[0]).toBe(`w1:p1 ${supervisorCommandFor("b-b9-t164")}`);
    }
    // Where a sandbox exists it wraps that command, and its config directory travels the same way
    // as the unattended flag, because the daemon inherits nothing (#489).
    if (sandboxAvailable()) {
      expect(commands[0]).toContain("sandbox-exec -p");
      expect(commands[0]).toMatch(/^w1:p1 PI_CODING_AGENT_DIR='/);
    } else {
      expect(commands[0]).toBe(`w1:p1 ${supervisorCommandFor("b-b9-t164")}`);
    }
  });
});

describe("the supervisor command names its extension when the config cannot (#548)", () => {
  it("puts the branch's own entry point on the command line", () => {
    expect(supervisorCommandFor("b1", { extension: "/w/src/pi/extension.ts" })).toBe(
      'MYPY_UNATTENDED=1 pi --extension "/w/src/pi/extension.ts" "/mypi-multi-agent b1"',
    );
  });

  it("leaves the command alone when the operator's config still supplies it", () => {
    expect(supervisorCommandFor("b1")).toBe('MYPY_UNATTENDED=1 pi "/mypi-multi-agent b1"');
  });
});

describe("#562: a repo without the driver's entry point still gets one", () => {
  it("prefers the tree's own copy, so a run tests the branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "mypi-ext-own-"));
    mkdirSync(join(dir, "src/pi"), { recursive: true });
    writeFileSync(join(dir, "src/pi/extension.ts"), "// entry\n");

    expect(extensionFor(dir)).toBe(join(dir, "src/pi/extension.ts"));

    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the driver's copy, which exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "mypi-ext-none-"));
    const named = extensionFor(dir);

    expect(named.startsWith(dir)).toBe(false);
    expect(named.endsWith("/src/pi/extension.ts")).toBe(true);
    expect(existsSync(named)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("#415: orphaned peers", () => {
  it("reaps this run's peers when the ticket ends, on the failing path too", async () => {
    const reaped: string[] = [];
    let clock = 0;
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: undefined }), {
        // The clock must move: a frozen one never reaches the timeout the test needs.
        now: () => (clock += 60_000),
        reapPeers: async (runDetails) => {
          reaped.push(runDetails);
          return false;
        },
      }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );

    expect(outcomes[0]).toMatchObject({ code: "startup-failed" });
    // Once before the attempt, once in the finally: a killed earlier run is cleared, and
    // this attempt's peers never outlive it.
    expect(reaped.length).toBeGreaterThanOrEqual(2);
    expect(reaped[0]).toBe(join(worktrees, "b-b9-t164", "mypi-tasks", "b-b9-t164", "run-details"));
    expect(new Set(reaped).size).toBe(1);
  });

  it("says so when it killed something an earlier run left behind", async () => {
    const progress: string[] = [];
    let clock = 0;
    await runBatch(
      deps(fakeHerdr({ final: { status: "done", exitCode: 0 } }), {
        now: () => (clock += 60_000),
        reapPeers: async () => true,
        progress: (line) => progress.push(line),
      }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 1 },
    );
    expect(progress.join("\n")).toContain("killed peers left behind by an earlier attempt");
  });
});

describe("#419: a failure says which gate term rejected it", () => {
  it("carries the gate term into the outcome, the summary and the writeback", async () => {
    const inner = fakeHerdr({ final: { status: "failure", exitCode: 1 } });
    const rejecting: Herdr = {
      ...inner,
      async runInPane(paneId, command) {
        await inner.runInPane(paneId, command);
        const slug = command.match(/mypi-multi-agent (b-[^"]+)"/)?.[1] ?? "";
        writeFileSync(
          join(worktrees, slug, "mypi-tasks", slug, "run-details", "conversation.jsonl"),
          `${JSON.stringify({
            type: "ERROR",
            event: "gate-rejected",
            term: "validation",
            detail: "bun run check",
          })}\n`,
        );
      },
    };

    let clock = 0;
    // A 5-minute budget: the clock advances a minute per call, so a 1-minute run would
    // time out during the two identical reads the completion rule needs.
    const outcomes = await runBatch(
      deps(rejecting, { now: () => (clock += 60_000) }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 5 },
    );

    expect(outcomes[0]).toMatchObject({ code: "failure" });
    expect(outcomes[0]?.detail).toBe("status failure; gate: validation (bun run check)");
    // The summary row and the ticket comment are where a human reads it.
    const summary = readFileSync(
      join(root, "mypi-tasks", "000-batches", "b9", "summary.md"),
      "utf8",
    );
    expect(summary).toContain("gate: validation (bun run check)");
    const comment = trackerOps.find((op) => op.op === "comment");
    expect(comment?.text).toContain("detail: status failure; gate: validation (bun run check)");
  });
});

describe("#415: the start block names the kind prepare accepted", () => {
  it("reads it from the record's acceptance.json", async () => {
    const record = join(root, "mypi-tasks/000-batches", REQUEST.id, "tickets", "164");
    writeFileSync(
      join(record, "acceptance.json"),
      `${JSON.stringify({ ticket: 164, kind: "code-fix" })}\n`,
    );
    const progress: string[] = [];
    let clock = 0;

    await runBatch(
      deps(fakeHerdr({ final: { status: "done", exitCode: 0 } }), {
        now: () => (clock += 60_000),
        progress: (line) => progress.push(line),
      }),
      { id: REQUEST.id, tickets: [164] },
      { timeoutMinutes: 5 },
    );

    expect(progress[0]).toBe("b9  #164  code-fix  b-b9-t164");
  });

  it("prints the block anyway when the record has no acceptance.json", async () => {
    const progress: string[] = [];
    let clock = 0;

    await runBatch(
      deps(fakeHerdr({ final: { status: "done", exitCode: 0 } }), {
        now: () => (clock += 60_000),
        progress: (line) => progress.push(line),
      }),
      { id: REQUEST.id, tickets: [164] },
      { timeoutMinutes: 5 },
    );

    expect(progress[0]).toBe("b9  #164  b-b9-t164");
  });
});
