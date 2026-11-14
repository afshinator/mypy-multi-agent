import { describe, expect, it } from "vitest";
import {
  advanceBatchBranch,
  batchBranch,
  createBatchBranch,
  type LandSeam,
  mergePR,
  openPR,
  ticketBranch,
} from "../../src/batch/land";

function seam(gh: Record<string, string> = {}): {
  seam: LandSeam;
  git: string[][];
  gh: string[][];
} {
  const git: string[][] = [];
  const ghCalls: string[][] = [];
  const fake: LandSeam = {
    cwd: "/repo",
    git: async (args) => {
      git.push(args);
      return "";
    },
    gh: async (args) => {
      ghCalls.push(args);
      return gh[args.join(" ")] ?? "";
    },
  };
  return { seam: fake, git, gh: ghCalls };
}

describe("land seam (#584)", () => {
  it("names the run and ticket branches", () => {
    expect(batchBranch("b9")).toBe("batch/b9");
    expect(ticketBranch("b-b9-t164")).toBe("task/b-b9-t164");
  });

  it("createBatchBranch branches from main", async () => {
    const { seam: s, git } = seam();
    await createBatchBranch(s, "b9");
    expect(git).toEqual([["branch", "batch/b9", "main"]]);
  });

  it("advanceBatchBranch force-moves the run branch to the ticket tip", async () => {
    const { seam: s, git } = seam();
    await advanceBatchBranch(s, "b9", "b-b9-t164");
    expect(git).toEqual([["branch", "-f", "batch/b9", "task/b-b9-t164"]]);
  });

  it("openPR pushes, sees no PR, and creates one", async () => {
    const { seam: s, git, gh } = seam();
    await openPR(s, "batch/b9", "batch b9");
    expect(git).toEqual([["push", "-u", "origin", "batch/b9"]]);
    expect(gh).toEqual([
      ["pr", "view", "batch/b9", "--json", "url", "-q", ".url"],
      ["pr", "create", "--base", "main", "--head", "batch/b9", "--title", "batch b9"],
    ]);
  });

  it("openPR skips create when a PR already exists", async () => {
    const { seam: s, gh } = seam({ "pr view batch/b9 --json url -q .url": "https://x" });
    await openPR(s, "batch/b9", "batch b9");
    expect(gh).toEqual([["pr", "view", "batch/b9", "--json", "url", "-q", ".url"]]);
  });

  it("mergePR polls, watches, then rebase-merges", async () => {
    const { seam: s, gh } = seam({ "pr checks batch/b9": "check" });
    await mergePR(s, "batch/b9", async () => {});
    expect(gh).toEqual([
      ["pr", "checks", "batch/b9"],
      ["pr", "checks", "batch/b9", "--watch", "--fail-fast"],
      ["pr", "merge", "batch/b9", "--rebase", "--delete-branch"],
    ]);
  });
});
