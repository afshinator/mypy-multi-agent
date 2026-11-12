import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeClone, removeClone } from "../../src/batch/clone";

let repo: string;
let clone: string | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "mypi-clone-src-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/index.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "package.json"), "{}\n");
  writeFileSync(join(repo, ".env.local"), "DATABASE_URL=postgres://prod\nCRON_SECRET=x\n");
  writeFileSync(join(repo, ".env.example"), "DATABASE_URL=\n");
  mkdirSync(join(repo, "nested"), { recursive: true });
  writeFileSync(join(repo, "nested/.env"), "TOKEN=secret\n");
});

afterEach(() => {
  clone = undefined;
  rmSync(repo, { recursive: true, force: true });
});

describe("makeClone", () => {
  it("copies the code and no environment file with a value in it (#500 review)", () => {
    // cp -R takes ignored files with it, and this is the one secret store a repo keeps in the tree.
    clone = makeClone(repo);

    expect(existsSync(join(clone, "src/index.ts"))).toBe(true);
    expect(existsSync(join(clone, "package.json"))).toBe(true);
    expect(existsSync(join(clone, ".env.local"))).toBe(false);
    expect(existsSync(join(clone, "nested/.env"))).toBe(false);
    // A template holds names, not values, so a claim may still read it.
    expect(existsSync(join(clone, ".env.example"))).toBe(true);
  });
});

describe("makeClone — the batch record stays behind (#546)", () => {
  it("omits the task dir, so a previous attempt's report cannot be read in the clone", () => {
    // The same ticket, refused before: its report and verdicts are what an agent would inherit.
    mkdirSync(join(repo, "mypi-tasks/000-batches/b1/tickets/42/attempts/1"), { recursive: true });
    writeFileSync(
      join(repo, "mypi-tasks/000-batches/b1/tickets/42/attempts/1/report.md"),
      "row 1\n",
    );
    writeFileSync(join(repo, "mypi-tasks/000-batches/b1/request.yaml"), "id: b1\n");

    clone = makeClone(repo, ["mypi-tasks"]);

    expect(existsSync(join(clone, "mypi-tasks"))).toBe(false);
    // The code is untouched: only the record leaves.
    expect(existsSync(join(clone, "src/index.ts"))).toBe(true);
  });

  it("keeps the record when no omission is named", () => {
    mkdirSync(join(repo, "mypi-tasks/000-batches/b1"), { recursive: true });
    writeFileSync(join(repo, "mypi-tasks/000-batches/b1/request.yaml"), "id: b1\n");

    clone = makeClone(repo);

    expect(existsSync(join(clone, "mypi-tasks/000-batches/b1/request.yaml"))).toBe(true);
  });
});

describe("removeClone", () => {
  it("removes the tree and tolerates one already gone", () => {
    const dir = makeClone(repo);
    removeClone(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeClone(dir)).not.toThrow();
  });
});
