import { describe, expect, it } from "vitest";
import { createHerdr } from "../../src/batch/herdr-cli";

/** Recorded bodies from live herdr calls on 2026-11-01. */
const CREATED = JSON.stringify({
  result: {
    root_pane: { pane_id: "w26:p1", workspace_id: "w26" },
    workspace: { workspace_id: "w26", label: "mypi-probe-209" },
  },
});
const FOUND = JSON.stringify({ result: { workspace: { workspace_id: "w26" } } });
const NOT_FOUND = JSON.stringify({
  error: { code: "workspace_not_found", message: "workspace w26 not found" },
});

function recorder(responses: Record<string, string>) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    return responses[args.slice(0, 2).join(" ")] ?? "";
  };
  return { calls, exec };
}

describe("createHerdr", () => {
  it("creates a workspace and returns both ids", async () => {
    const { calls, exec } = recorder({ "workspace create": CREATED });
    const herdr = createHerdr(exec);

    await expect(
      herdr.createWorkspace({ cwd: "/tmp/wt", label: "mypi-b-b9-t164" }),
    ).resolves.toEqual({
      workspaceId: "w26",
      paneId: "w26:p1",
    });
    expect(calls[0]).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/tmp/wt",
      "--label",
      "mypi-b-b9-t164",
      "--no-focus",
    ]);
  });

  it("runs the launch command in the pane as one argument", async () => {
    const { calls, exec } = recorder({ "pane run": "" });

    await createHerdr(exec).runInPane("w26:p1", 'pi "/mypi-multi-agent b-b9-t164"');

    expect(calls[0]).toEqual(["pane", "run", "w26:p1", 'pi "/mypi-multi-agent b-b9-t164"']);
  });

  it("reads absence from the body, because `workspace get` exits 0 when it is gone", async () => {
    expect(
      await createHerdr(recorder({ "workspace get": NOT_FOUND }).exec).workspaceExists("w26"),
    ).toBe(false);
    expect(
      await createHerdr(recorder({ "workspace get": FOUND }).exec).workspaceExists("w26"),
    ).toBe(true);
  });

  it("treats a failing `workspace get` as still alive rather than abandoning a live run", async () => {
    const herdr = createHerdr(async () => {
      throw new Error("herdr: connection refused");
    });
    expect(await herdr.workspaceExists("w26")).toBe(true);
  });

  it("closes by workspace id and tolerates an already-closed workspace", async () => {
    const { calls, exec } = recorder({ "workspace close": "" });
    await createHerdr(exec).closeWorkspace("w26");
    expect(calls[0]).toEqual(["workspace", "close", "w26"]);

    const failing = createHerdr(async () => {
      throw new Error("workspace_not_found");
    });
    await expect(failing.closeWorkspace("w26")).resolves.toBeUndefined();
  });

  it("refuses a create that omits the ids", async () => {
    const herdr = createHerdr(async () => JSON.stringify({ result: {} }));
    await expect(herdr.createWorkspace({ cwd: "/tmp", label: "x" })).rejects.toThrow(
      /no workspace_id/,
    );
  });
});
