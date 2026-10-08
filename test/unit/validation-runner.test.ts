/**
 * Unit tests for the validation runner module.
 */
import { describe, expect, it, vi } from "vitest";
import { ChangeDetector } from "../../src/validation/change-detector";
import { runValidation, validationAllowsSuccess } from "../../src/validation/validation-runner";

describe("runValidation", () => {
  it("no validation config → not-configured, exec not called", async () => {
    const exec = vi.fn();
    const r = await runValidation(undefined, true, exec);
    expect(r).toEqual({ status: "not-configured" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("validation configured but no code change → skipped", async () => {
    const exec = vi.fn();
    const r = await runValidation({ commands: ["just test"] }, false, exec);
    expect(r).toEqual({ status: "skipped" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("code changed and commands pass → passed", async () => {
    const exec = vi.fn(async () => true);
    const r = await runValidation({ commands: ["just test"] }, true, exec);
    expect(r).toEqual({ status: "passed" });
    expect(exec).toHaveBeenCalledWith("just test");
  });

  it("fail then repaired → failed then passed", async () => {
    let first = true;
    const exec = vi.fn(async () => {
      if (first) {
        first = false;
        return false;
      }
      return true;
    });
    const r1 = await runValidation({ commands: ["just test"] }, true, exec);
    expect(r1).toMatchObject({ status: "failed" });
    const r2 = await runValidation({ commands: ["just test"] }, true, exec);
    expect(r2).toEqual({ status: "passed" });
  });

  it("still failing at finalization → cannot succeed", async () => {
    const exec = vi.fn(async () => false);
    const r = await runValidation({ commands: ["just test"] }, true, exec);
    expect(r).toMatchObject({ status: "failed" });
    expect(validationAllowsSuccess(r)).toBe(false);
  });

  it("validationAllowsSuccess on pass/skip/not-configured", async () => {
    expect(validationAllowsSuccess({ status: "passed" })).toBe(true);
    expect(validationAllowsSuccess({ status: "skipped" })).toBe(true);
    expect(validationAllowsSuccess({ status: "not-configured" })).toBe(true);
  });
});

describe("ChangeDetector", () => {
  it("marks and reports code change", () => {
    const c = new ChangeDetector();
    expect(c.hasChanged()).toBe(false);
    c.markChanged();
    expect(c.hasChanged()).toBe(true);
  });
});
