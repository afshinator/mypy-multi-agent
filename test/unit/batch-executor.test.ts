import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ExecutorDeps, type Herdr, runBatch } from "../../src/batch/executor";
import { buildManifestText } from "../../src/batch/manifest";
import type { BatchPolicy } from "../../src/batch/policy";
import type { BatchRequest } from "../../src/batch/request";

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
      if (behaviour.final === undefined) return;
      const slug = command.match(/mypi-multi-agent (b-[^"]+)"/)?.[1] ?? "";
      const dir = join(worktrees, slug, "mypi-tasks", slug, "run-details");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "final.md"),
        `---\nstatus: ${behaviour.final.status}\nexit_code: ${behaviour.final.exitCode}\ncost: 0.00\n---\n\nbody\n`,
      );
      writeFileSync(join(dir, "scorecard.json"), "{}\n");
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
    preflight: async (slugs) => slugs.map((slug) => ({ slug, ok: true })),
    createWorktree: async ({ slug }) => {
      const path = join(worktrees, slug);
      mkdirSync(path, { recursive: true });
      return { path };
    },
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
  for (const ticket of REQUEST.tickets) {
    const dir = join(root, "batches", REQUEST.id, "tickets", String(ticket));
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

    const record = join(root, "batches/b9/tickets/164");
    const run = JSON.parse(readFileSync(join(record, "run.json"), "utf8")) as {
      code: string;
      exitCode: number;
    };
    expect(run).toMatchObject({ code: "success", exitCode: 0 });
    // The artifacts are copied out; nothing is written inside the worktree's run-details.
    expect(readFileSync(join(record, "final.md"), "utf8")).toContain("status: success");
    expect(readFileSync(join(record, "scorecard.json"), "utf8")).toBe("{}\n");
  });

  it("writes a batch summary a human can read, and one that parses", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "success", exitCode: 0 } })), REQUEST);

    const summary = JSON.parse(readFileSync(join(root, "batches/b9/summary.json"), "utf8")) as {
      id: string;
      outcomes: { code: string }[];
    };
    expect(summary.id).toBe("b9");
    expect(summary.outcomes.map((o) => o.code)).toEqual(["success", "success"]);

    const text = readFileSync(join(root, "batches/b9/summary.md"), "utf8");
    expect(text).toContain("2 of 2 succeeded.");
    expect(text).toContain("| 164 |");
  });

  it("records where a halted batch stopped", async () => {
    await runBatch(deps(fakeHerdr({ final: { status: "failure", exitCode: 1 } })), REQUEST);

    const text = readFileSync(join(root, "batches/b9/summary.md"), "utf8");
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
    let clock = 0;
    const outcomes = await runBatch(
      deps(fakeHerdr({ final: undefined }), { now: () => (clock += 60_000) }),
      { id: "b9", tickets: [164] },
      { timeoutMinutes: 5 },
    );

    expect(outcomes[0]).toMatchObject({ code: "timeout" });
    expect(closed).toEqual(["w1"]);
  });

  it("refuses an invalid manifest without creating a worktree or a workspace", async () => {
    writeFileSync(
      join(root, "batches/b9/tickets/164/manifest.yaml"),
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
    mkdirSync(join(root, "batches/b9/tickets/164"), { recursive: true });
    writeFileSync(join(root, "batches/b9/tickets/164/run.json"), "{}\n");

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
