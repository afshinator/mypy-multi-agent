/**
 * Discovery wiring over the pure DirReader seam (#66). The config parser is
 * already tested in the main repo; here we only prove the ordered taskDirs
 * walk, the run-details/ gate, first-wins dedup, and the missing-config path.
 */
import { describe, expect, it } from "vitest";
import { discoverProjects } from "../lib/discovery";
import type { DirEntry, DirReader, FileText } from "../lib/reader";

interface FsNode {
  type: "dir" | "file";
  children: Map<string, FsNode>;
  text?: string;
  mtimeMs?: number;
}

const dir = (children: Record<string, FsNode> = {}): FsNode => ({
  type: "dir",
  children: new Map(Object.entries(children)),
});

const file = (text: string, mtimeMs?: number): FsNode => ({
  type: "file",
  children: new Map(),
  text,
  mtimeMs,
});

/** In-memory DirReader rooted at the project root (`root === ""`). */
class MemoryReader implements DirReader {
  constructor(private readonly root: FsNode) {}

  private nodeAt(path: string): FsNode | null {
    if (path === "") return this.root;
    let node: FsNode | undefined = this.root;
    for (const part of path.split("/")) {
      if (part === "") continue;
      node = node.children.get(part);
      if (node === undefined) return null;
    }
    return node;
  }

  async list(path: string): Promise<DirEntry[]> {
    const node = this.nodeAt(path);
    if (node === null || node.type !== "dir") return [];
    return [...node.children.entries()].map(([name, child]) => ({
      name,
      isDir: child.type === "dir",
    }));
  }

  async readText(path: string): Promise<FileText | null> {
    const node = this.nodeAt(path);
    if (node === null || node.type !== "file") return null;
    return { text: node.text ?? "", mtimeMs: node.mtimeMs };
  }
}

const configYaml = (taskDirs: readonly string[]): string =>
  `version: 1\ntaskDirs:\n${taskDirs.map((d) => `  - ${d}`).join("\n")}\n`;

const task = (conversationMtimeMs: number): FsNode =>
  dir({
    "run-details": dir({
      "conversation.jsonl": file("{}", conversationMtimeMs),
      "final.md": file("# final\n"),
    }),
  });

describe("discoverProjects", () => {
  it("discovers tasks from ordered taskDirs", async () => {
    const root = dir({
      "mypi-multi-agent.yaml": file(configYaml(["first", "second"])),
      first: dir({
        alpha: task(2000),
        beta: task(1000),
      }),
      second: dir({
        gamma: task(3000),
      }),
    });
    const reader = new MemoryReader(root);

    const tasks = await discoverProjects(reader, "");

    expect(tasks.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(tasks.map((t) => t.runDetailsPath)).toEqual([
      "first/alpha/run-details",
      "first/beta/run-details",
      "second/gamma/run-details",
    ]);
  });

  it("deduplicates first-wins when a name appears in two taskDirs", async () => {
    const root = dir({
      "mypi-multi-agent.yaml": file(configYaml(["first", "second"])),
      first: dir({ dup: task(1000), onlyFirst: task(1100) }),
      second: dir({ dup: task(2000), onlySecond: task(2100) }),
    });
    const reader = new MemoryReader(root);

    const tasks = await discoverProjects(reader, "");

    expect(tasks.map((t) => t.name)).toEqual(["dup", "onlyFirst", "onlySecond"]);
    expect(tasks.find((t) => t.name === "dup")?.runDetailsPath).toBe("first/dup/run-details");
  });

  it("returns an empty list when the config is missing", async () => {
    const root = dir({ tasks: dir({ alpha: task(1000) }) });
    const reader = new MemoryReader(root);

    await expect(discoverProjects(reader, "")).resolves.toEqual([]);
  });

  it("returns an empty list when the config is unparseable", async () => {
    const root = dir({ "mypi-multi-agent.yaml": file("version: 2\ntaskDirs:\n  - x\n") });
    const reader = new MemoryReader(root);

    await expect(discoverProjects(reader, "")).resolves.toEqual([]);
  });

  it("does not treat a dir without run-details/ as a task", async () => {
    const root = dir({
      "mypi-multi-agent.yaml": file(configYaml(["first"])),
      first: dir({
        real: task(1000),
        notATask: dir({ "session.yaml": file("x") }),
      }),
    });
    const reader = new MemoryReader(root);

    const tasks = await discoverProjects(reader, "");

    expect(tasks.map((t) => t.name)).toEqual(["real"]);
  });
});
