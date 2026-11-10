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

describe("removeClone", () => {
  it("removes the tree and tolerates one already gone", () => {
    const dir = makeClone(repo);
    removeClone(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => removeClone(dir)).not.toThrow();
  });
});
