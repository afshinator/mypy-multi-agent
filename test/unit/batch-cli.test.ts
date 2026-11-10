import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, outcomeLine, progressFor } from "../../src/batch/cli";
import { parseRequest } from "../../src/batch/request";

const POLICY = `version: 1
prepare:
  kinds: [code-fix]
  kind_templates:
    code-fix: templates/batch-code-fix.yaml
  triage_model: a/b
  verifier_model: c/d
  agent_timeout_minutes: 5
run:
  timeout_minutes: 5
`;

let cwd: string;
const out: string[] = [];
const err: string[] = [];
const io = {
  get cwd() {
    return cwd;
  },
  out: (line: string) => out.push(line),
  err: (line: string) => err.push(line),
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mypi-batch-cli-"));
  out.length = 0;
  err.length = 0;
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("mypi-batch new", () => {
  it("writes a request the parser accepts", async () => {
    expect(await main(["new", "b1", "163", "164"], io)).toBe(0);

    const written = readFileSync(join(cwd, "mypi-tasks/000-batches/b1/request.yaml"), "utf8");
    expect(parseRequest(written)).toEqual({ id: "b1", tickets: [163, 164] });
    expect(out.join("\n")).toContain("mypi-tasks/000-batches/b1/request.yaml");
  });

  it("is write-once: an existing request is refused, not overwritten", async () => {
    expect(await main(["new", "b1", "163"], io)).toBe(0);
    expect(await main(["new", "b1", "164"], io)).toBe(1);

    expect(
      parseRequest(readFileSync(join(cwd, "mypi-tasks/000-batches/b1/request.yaml"), "utf8"))
        .tickets,
    ).toEqual([163]);
    expect(err.join("\n")).toMatch(/already exists/);
  });

  it("refuses an id that would not survive as a directory name", async () => {
    expect(await main(["new", "B_1", "163"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/id/);
  });

  it("refuses a request with no tickets", async () => {
    expect(await main(["new", "b1"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch new/);
  });
});

describe("mypi-batch dispatch", () => {
  it("lists the verbs and exits 0 for --help", async () => {
    expect(await main(["--help"], io)).toBe(0);
    expect(out.join("\n")).toContain("new <id> <ticket...>");
  });

  it("refuses a verb that is not implemented yet instead of doing nothing", async () => {
    expect(await main(["retemplate", "b1", "163", "code-fix"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/unknown command "retemplate"/);
    expect(err.join("\n")).toContain("new <id> <ticket...>");
  });

  it("run refuses without a batch id", async () => {
    expect(await main(["run"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch run/);
  });

  it("run refuses a batch with no request file", async () => {
    expect(await main(["run", "nope"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/ENOENT|no such file/);
  });

  it("run refuses a batch whose manifest is invalid, before any herdr call", async () => {
    mkdirSync(join(cwd, "mypi-tasks/000-batches/b1/tickets"), { recursive: true });
    writeFileSync(join(cwd, "mypi-tasks/000-batches/b1/request.yaml"), "id: b1\ntickets: [164]\n");
    mkdirSync(join(cwd, "mypi-tasks/000-batches/b1/tickets/164"), { recursive: true });
    writeFileSync(
      join(cwd, "mypi-tasks/000-batches/b1/tickets/164/manifest.yaml"),
      "version: '1.2'\nsession: {}\nagents: []\n",
    );
    writeFileSync(join(cwd, "mypi-batch.yaml"), POLICY);
    writeFileSync(join(cwd, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");

    expect(await main(["run", "b1"], io)).toBe(1);
    expect(out.join("\n")).toContain("manifest-invalid");
    // Refused before running: no per-ticket run record was written.
    expect(existsSync(join(cwd, "mypi-tasks/000-batches/b1/tickets/164/run.json"))).toBe(false);
    // The batch still ended, so `status --wait` has a file to stop on.
    expect(existsSync(join(cwd, "mypi-tasks/000-batches/b1/summary.json"))).toBe(true);
  });

  it("check refuses without a batch id", async () => {
    expect(await main(["check"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch check/);
  });

  it("check reports a missing request file rather than reading the tracker", async () => {
    expect(await main(["check", "nope"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/ENOENT|no such file/);
  });

  it("prepare refuses without a batch id", async () => {
    expect(await main(["prepare"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch prepare/);
  });

  it("prepare refuses a batch that has no request file, before spending anything", async () => {
    expect(await main(["prepare", "nope"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/ENOENT|no such file/);
  });

  it("prepare refuses --kind beside a per-ticket mapping, before spending anything", async () => {
    const batch = join(cwd, "mypi-tasks/000-batches/b1");
    mkdirSync(batch, { recursive: true });
    writeFileSync(join(cwd, "mypi-batch.yaml"), POLICY);
    writeFileSync(
      join(batch, "request.yaml"),
      "id: b1\ntickets: [163, 164]\nkind:\n  163: code-fix\n  164: code-fix\n",
    );

    expect(await main(["prepare", "b1", "--kind", "code-fix"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/conflicts with the request's per-ticket kind mapping/);
    expect(existsSync(join(batch, "tickets"))).toBe(false);
  });
});

describe("mypi-batch status", () => {
  const batch = "mypi-tasks/000-batches/b1";

  function request(tickets = [163, 164]) {
    mkdirSync(join(cwd, batch), { recursive: true });
    writeFileSync(join(cwd, batch, "request.yaml"), `id: b1\ntickets: [${tickets.join(", ")}]\n`);
  }

  function record(ticket: number, outcome: Record<string, unknown>) {
    mkdirSync(join(cwd, batch, "tickets", String(ticket)), { recursive: true });
    writeFileSync(join(cwd, batch, "tickets", String(ticket), "run.json"), JSON.stringify(outcome));
  }

  it("says pending for a ticket with no record, and does not wait by default", async () => {
    request();

    expect(await main(["status", "b1"], io)).toBe(0);
    expect(out).toEqual(["163\tpending", "164\tpending"]);
  });

  it("reports each finished ticket's code and detail from its own record", async () => {
    request();
    record(163, { ticket: 163, code: "success", durationMs: 12 });
    record(164, { ticket: 164, code: "failure", detail: "no commits" });

    expect(await main(["status", "b1"], io)).toBe(0);
    expect(out).toEqual(["163\tsuccess", "164\tfailure\tno commits"]);
  });

  it("fills a ticket that never ran from the batch summary", async () => {
    request();
    record(163, { ticket: 163, code: "success" });
    writeFileSync(
      join(cwd, batch, "summary.json"),
      JSON.stringify({
        id: "b1",
        totalCostUsd: 0,
        outcomes: [
          { ticket: 163, code: "success" },
          { ticket: 164, code: "halted", detail: "163 failed" },
        ],
      }),
    );

    expect(await main(["status", "b1"], io)).toBe(0);
    expect(out).toEqual(["163\tsuccess", "164\thalted\t163 failed"]);
  });

  it("--wait returns once the batch summary appears", async () => {
    request();
    const marker = join(cwd, batch, "summary.json");
    const timer = setTimeout(() => {
      writeFileSync(
        marker,
        JSON.stringify({ id: "b1", totalCostUsd: 0, outcomes: [{ ticket: 163, code: "success" }] }),
      );
    }, 50);

    expect(await main(["status", "b1", "--wait", "--interval", "5"], io)).toBe(0);
    clearTimeout(timer);
    expect(out.join("\n")).toContain("163\tsuccess");
  });

  it("refuses without a batch id, or with an interval that is not a number", async () => {
    expect(await main(["status"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch status/);

    err.length = 0;
    request();
    expect(await main(["status", "b1", "--interval", "soon"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch status/);
  });
});

describe("mypi-batch prepare outcome line", () => {
  it("ends with the Phase A spend", () => {
    expect(
      outcomeLine({
        ticket: 17,
        ok: true,
        kind: "writer-solo",
        slug: "b-rung1-t17",
        criteria: ["a", "b"],
        costUsd: 0.0412,
      }),
    ).toBe("17\tok\twriter-solo b-rung1-t17 2 criteria\t$0.0412");
  });

  it("has no cost column for a ticket that never reached an agent", () => {
    // Absent is not zero: a refusal before the first model call spent nothing measurable.
    expect(
      outcomeLine({ ticket: 17, ok: false, code: "not-needed", detail: "issue is CLOSED" }),
    ).toBe("17\tnot-needed\tissue is CLOSED");
  });
});

describe("mypi-batch launch", () => {
  function seedManifest(): void {
    writeFileSync(join(cwd, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");
    const recordDir = join(cwd, "mypi-tasks/000-batches/b1/tickets/164");
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, "manifest.yaml"), "version: '1'\nsession: {}\n");
  }

  it("materialises a halted ticket's manifest into its task dir", async () => {
    seedManifest();

    expect(await main(["launch", "b1", "164"], io)).toBe(0);
    const written = readFileSync(join(cwd, "mypi-tasks/b-b1-t164/session.yaml"), "utf8");
    expect(written).toContain("version: '1'");
    expect(out.join("\n")).toContain("mypi-tasks/b-b1-t164/session.yaml");
  });

  it("refuses to launch a ticket that already ran", async () => {
    seedManifest();
    mkdirSync(join(cwd, "mypi-tasks/b-b1-t164/run-details"), { recursive: true });
    writeFileSync(
      join(cwd, "mypi-tasks/b-b1-t164/run-details/final.md"),
      "---\nstatus: success\nexit_code: 0\n---\n",
    );

    expect(await main(["launch", "b1", "164"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/already ran/);
  });

  it("refuses a ticket that has no prepared manifest", async () => {
    writeFileSync(join(cwd, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");

    expect(await main(["launch", "b1", "164"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/prepare/);
  });
});

describe("mypi-batch prepare outcome line — retry trail (#375)", () => {
  it("appends the retried site after the cost", () => {
    expect(
      outcomeLine({
        ticket: 17,
        ok: true,
        kind: "code-fix",
        slug: "b1-t17",
        criteria: ["a"],
        costUsd: 0.02,
        retried: ["verifier"],
      }),
    ).toBe("17\tok\tcode-fix b1-t17 1 criteria\t$0.02\tretried: verifier");
  });

  it("names every site, and adds nothing when none was retried", () => {
    expect(
      outcomeLine({
        ticket: 17,
        ok: false,
        code: "infra-error",
        detail: "conn",
        costUsd: 0.03,
        retried: ["triage", "verifier"],
      }),
    ).toBe("17\tinfra-error\tconn\t$0.03\tretried: triage, verifier");
    expect(
      outcomeLine({
        ticket: 17,
        ok: true,
        kind: "writer",
        criteria: [],
        costUsd: 0.01,
        retried: [],
      }),
    ).toBe("17\tok\twriter 0 criteria\t$0.01");
  });
});

describe("#415: run output", () => {
  it("prints progress by default, and nothing but the ticket lines with --quiet", () => {
    const lines: string[] = [];
    const out = (line: string): void => {
      lines.push(line);
    };
    // Default: the run's progress reaches the same sink as the final lines.
    expect(progressFor(false, out)).toBe(out);
    // --quiet: no progress sink at all, so only the per-ticket lines are printed.
    expect(progressFor(true, out)).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("documents --quiet in the verbs it lists", async () => {
    const lines: string[] = [];
    await main(["--help"], { cwd: process.cwd(), out: (l) => lines.push(l), err: () => {} });
    expect(lines.join("\n")).toContain("run <id> [--quiet]");
  });
});
