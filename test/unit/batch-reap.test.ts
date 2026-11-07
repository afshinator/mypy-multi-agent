import { describe, expect, it } from "vitest";
import { createReaper } from "../../src/batch/reap";

describe("#415: reaping orphan peers", () => {
  it("matches this run's own run-details path, and nothing wider", async () => {
    const seen: string[][] = [];
    const reap = createReaper(async (args) => {
      seen.push(args);
      return "";
    });
    const killed = await reap("/wt/b-b9-t164/mypi-tasks/b-b9-t164/run-details");
    expect(killed).toBe(true);
    expect(seen).toEqual([["-f", "/wt/b-b9-t164/mypi-tasks/b-b9-t164/run-details/.peer-"]]);
    // The scope is the absolute path: no bare `pkill peer-main`, which would kill another run.
    expect(seen[0]?.join(" ")).not.toMatch(/^-f peer-main$|it is not|^-f \.peer-$/);
  });

  it("treats 'nothing matched' as the ordinary case, not a failure", async () => {
    const reap = createReaper(async () => {
      throw new Error("exit 1");
    });
    await expect(reap("/x/run-details")).resolves.toBe(false);
  });
});

describe("#415: the unattended stance reaches the peers", () => {
  it("prefixes a peer's launch command when the supervisor is unattended", async () => {
    const { peerCommandFor } = await import("../../src/runtime/runtime");
    // A pane is created by the herdr daemon, so a peer inherits nothing from the supervisor.
    expect(peerCommandFor("/p/peer-main.ts", "/r/.peer-a.json", { MYPY_UNATTENDED: "1" })).toBe(
      "MYPY_UNATTENDED=1 bun /p/peer-main.ts --config /r/.peer-a.json",
    );
    expect(peerCommandFor("/p/peer-main.ts", "/r/.peer-a.json", {})).toBe(
      "bun /p/peer-main.ts --config /r/.peer-a.json",
    );
  });
});
