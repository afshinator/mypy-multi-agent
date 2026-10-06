import { describe, expect, it, vi } from "vitest";
import { runStartup } from "../../src/control/startup";
import { EXIT } from "../../src/runtime/exit";

describe("runStartup", () => {
  it("invalid config → exit 3, bus not started", async () => {
    const startBus = vi.fn(async () => {});
    const r = await runStartup({
      parseConfig: () => {
        throw new Error("bad config");
      },
      startBus,
    });
    expect(r).toEqual({ ok: false, exitCode: EXIT.CONFIG_ERROR });
    expect(startBus).not.toHaveBeenCalled();
  });

  it("bus startup failure → exit 3", async () => {
    const r = await runStartup({
      parseConfig: () => {},
      startBus: async () => {
        throw new Error("bus bind failed");
      },
    });
    expect(r).toEqual({ ok: false, exitCode: EXIT.CONFIG_ERROR });
  });

  it("success → ok", async () => {
    const r = await runStartup({ parseConfig: () => {}, startBus: async () => {} });
    expect(r).toEqual({ ok: true });
  });
});
