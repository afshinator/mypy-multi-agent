import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prompt = readFileSync(join(repoRoot, "src/pi/supervisor-prompt.md"), "utf8");

const PONYTAIL_MENTION = /ponytail|load the skill|`\w+` skill/i;

describe("default supervisor prompt", () => {
  it("names no skill for peers to load", () => {
    // Every session loads this file, so a skill named here is imposed on every
    // task — including tasks with no code to write. A task that wants a skill
    // says so in its own supervisor_system_prompt or agent prompts.
    expect(prompt).not.toMatch(PONYTAIL_MENTION);
  });

  it("still declares the validation gate duty", () => {
    // The lint/format duty is a run contract, not a skill: it names the task's
    // own validation.commands, so it stays.
    expect(prompt).toMatch(/LINT\/FORMAT/);
    expect(prompt).toContain("Never claim a\n  command you did not run");
  });
});
