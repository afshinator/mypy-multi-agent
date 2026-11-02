import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/batch/cli";
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

    const written = readFileSync(join(cwd, "batches/b1/request.yaml"), "utf8");
    expect(parseRequest(written)).toEqual({ id: "b1", tickets: [163, 164] });
    expect(out.join("\n")).toContain("batches/b1/request.yaml");
  });

  it("is write-once: an existing request is refused, not overwritten", async () => {
    expect(await main(["new", "b1", "163"], io)).toBe(0);
    expect(await main(["new", "b1", "164"], io)).toBe(1);

    expect(
      parseRequest(readFileSync(join(cwd, "batches/b1/request.yaml"), "utf8")).tickets,
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
    mkdirSync(join(cwd, "batches/b1/tickets"), { recursive: true });
    writeFileSync(join(cwd, "batches/b1/request.yaml"), "id: b1\ntickets: [164]\n");
    mkdirSync(join(cwd, "batches/b1/tickets/164"), { recursive: true });
    writeFileSync(
      join(cwd, "batches/b1/tickets/164/manifest.yaml"),
      "version: '1.2'\nsession: {}\nagents: []\n",
    );
    writeFileSync(join(cwd, "mypi-batch.yaml"), POLICY);
    writeFileSync(join(cwd, "mypi-multi-agent.yaml"), "version: 1\ntaskDirs:\n  - mypi-tasks\n");

    expect(await main(["run", "b1"], io)).toBe(1);
    expect(out.join("\n")).toContain("manifest-invalid");
    // The executor refuses before creating anything, so no worktree or workspace exists.
    expect(existsSync(join(cwd, "mypi-tasks"))).toBe(false);
  });

  it("prepare refuses without a batch id", async () => {
    expect(await main(["prepare"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch prepare/);
  });

  it("prepare refuses a batch that has no request file, before spending anything", async () => {
    expect(await main(["prepare", "nope"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/ENOENT|no such file/);
  });
});
