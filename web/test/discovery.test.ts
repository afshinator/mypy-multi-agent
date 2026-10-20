import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DirEntry, DirReader, FileText } from "../lib/discovery";
import { discoverProjects } from "../lib/discovery";

type Node =
  | { kind: "dir"; children: Record<string, Node> }
  | { kind: "file"; text: string; mtimeMs?: number };

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function readerFromTree(root: Node): DirReader {
  const at = (path: string): Node | null => {
    if (path === "") return root;
    let cur: Node = root;
    for (const seg of path.split("/")) {
      if (cur.kind !== "dir") return null;
      const next = cur.children[seg];
      if (next === undefined) return null;
      cur = next;
    }
    return cur;
  };
  return {
    async list(path: string): Promise<DirEntry[]> {
      const node = at(path);
      if (node === null || node.kind !== "dir") return [];
      return Object.entries(node.children).map(([name, child]) => ({
        name,
        isDir: child.kind === "dir",
      }));
    },
    async readText(path: string): Promise<FileText | null> {
      const node = at(path);
      if (node === null || node.kind !== "file") return null;
      return { text: node.text, mtimeMs: node.mtimeMs };
    },
  };
}

const tree: Node = {
  kind: "dir",
  children: {
    ".mypi": {
      kind: "dir",
      children: {
        "recent-task": {
          kind: "dir",
          children: {
            "run-details": {
              kind: "dir",
              children: {
                "run-state.json": { kind: "file", text: fixture("run-state-recent.json") },
                "final.md": { kind: "file", text: fixture("final-success.md") },
              },
            },
          },
        },
        "old-task": {
          kind: "dir",
          children: {
            "run-details": {
              kind: "dir",
              children: {
                "run-state.json": { kind: "file", text: fixture("run-state-old.json") },
                "final.md": { kind: "file", text: fixture("final-failure.md") },
              },
            },
          },
        },
        "no-state-task": {
          kind: "dir",
          children: {
            "run-details": {
              kind: "dir",
              children: {
                "final.md": { kind: "file", text: fixture("final-failure.md"), mtimeMs: 1500 },
              },
            },
          },
        },
        "not-a-run": {
          kind: "dir",
          children: {
            "session.yaml": { kind: "file", text: 'version: "1.2"\n' },
          },
        },
      },
    },
    pkg: {
      kind: "dir",
      children: {
        ".mypi": {
          kind: "dir",
          children: {
            "mid-task": {
              kind: "dir",
              children: {
                "run-details": {
                  kind: "dir",
                  children: {
                    "run-state.json": { kind: "file", text: fixture("run-state-mid.json") },
                    "final.md": { kind: "file", text: fixture("final-success.md") },
                  },
                },
              },
            },
          },
        },
      },
    },
    deep: {
      kind: "dir",
      children: {
        inner: {
          kind: "dir",
          children: {
            ".mypi": {
              kind: "dir",
              children: {
                "ghost-task": {
                  kind: "dir",
                  children: { "run-details": { kind: "dir", children: {} } },
                },
              },
            },
          },
        },
      },
    },
    "no-mypi": {
      kind: "dir",
      children: { "file.txt": { kind: "file", text: "x" } },
    },
  },
};

describe("discoverProjects", () => {
  it("finds root and one-level .mypi tasks, ignores run-details-less and deep .mypi", async () => {
    const projects = await discoverProjects(readerFromTree(tree));
    expect(projects.map((p) => p.name)).toEqual(["", "pkg"]);
    expect(projects[0]?.tasks.map((t) => t.name)).toEqual([
      "recent-task",
      "no-state-task",
      "old-task",
    ]);
    expect(projects[1]?.tasks.map((t) => t.name)).toEqual(["mid-task"]);
  });

  it("parses exit code from final.md and cost from run-state.json", async () => {
    const projects = await discoverProjects(readerFromTree(tree));
    const rootTasks = Object.fromEntries((projects[0]?.tasks ?? []).map((t) => [t.name, t]));
    expect(rootTasks["recent-task"]?.exitCode).toBe(0);
    expect(rootTasks["recent-task"]?.costUsd).toBe(0.3);
    expect(rootTasks["old-task"]?.exitCode).toBe(1);
    expect(rootTasks["no-state-task"]?.exitCode).toBe(1);
    expect(rootTasks["no-state-task"]?.costUsd).toBeUndefined();
  });

  it("sorts tasks and projects by recency, falling back to directory mtime", async () => {
    const projects = await discoverProjects(readerFromTree(tree));
    expect(projects[0]?.name).toBe("");
    expect(projects[1]?.name).toBe("pkg");
    // no-state-task (mtime 1500) sorts before old-task (startedAtMs 1000).
    expect(projects[0]?.tasks.map((t) => t.name)).toEqual([
      "recent-task",
      "no-state-task",
      "old-task",
    ]);
    expect(projects[0]?.tasks[1]?.startedAtMs).toBeUndefined();
  });

  it("uses the newest artifact mtime as the directory-mtime proxy", async () => {
    const mtimeTree: Node = {
      kind: "dir",
      children: {
        ".mypi": {
          kind: "dir",
          children: {
            task: {
              kind: "dir",
              children: {
                "run-details": {
                  kind: "dir",
                  children: {
                    "run-state.json": {
                      kind: "file",
                      text: fixture("run-state-recent.json"),
                      mtimeMs: 1000,
                    },
                    "final.md": { kind: "file", text: fixture("final-success.md"), mtimeMs: 3000 },
                    "conversation.jsonl": { kind: "file", text: "{}", mtimeMs: 2000 },
                  },
                },
              },
            },
          },
        },
      },
    };
    const projects = await discoverProjects(readerFromTree(mtimeTree));
    expect(projects[0]?.tasks[0]?.mtimeMs).toBe(3000);
  });
});
