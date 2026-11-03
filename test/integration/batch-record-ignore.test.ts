/**
 * The batch record's git boundary (#261): authored decisions are committed,
 * raw agent output stays local. `.gitignore` ignores exactly `report.md` and
 * `verdicts.json` under the record's `tickets/<n>/`, and nothing else there —
 * so a prepare-only batch leaves `request.yaml`, the acceptance/refusal records
 * and the manifests committable, and the old pre-#264 `batches/` rule is gone.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const ignored = (path: string): boolean =>
  spawnSync("git", ["check-ignore", "-q", path], { cwd: repoRoot }).status === 0;

const RECORD = "mypi-tasks/000-batches/b1";

describe(".gitignore batch record boundary", () => {
  const committed = [
    `${RECORD}/request.yaml`,
    `${RECORD}/summary.md`,
    `${RECORD}/summary.json`,
    `${RECORD}/tickets/42/acceptance.json`,
    `${RECORD}/tickets/42/refusal.json`,
    `${RECORD}/tickets/42/manifest.yaml`,
    `${RECORD}/tickets/42/run.json`,
  ];
  const agentOutput = [`${RECORD}/tickets/42/report.md`, `${RECORD}/tickets/42/verdicts.json`];

  it("ignores only the raw agent output and commits the decisions", () => {
    for (const path of committed) {
      expect(ignored(path), `${path} must be committable`).toBe(false);
    }
    for (const path of agentOutput) {
      expect(ignored(path), `${path} must be ignored`).toBe(true);
    }
  });

  it("no longer carries the pre-#264 batches/ ignore rule", () => {
    const lines = readFileSync(join(repoRoot, ".gitignore"), "utf8").split("\n");
    expect(lines.some((line) => line.startsWith("batches/"))).toBe(false);
  });
});
