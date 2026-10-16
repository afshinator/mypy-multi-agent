/**
 * Unit tests for the launcher's pure contract (the herdr bootstrap plan). The
 * live spawn is exercised only in a real herdr environment.
 */

import { describe, expect, it } from "vitest";
import { buildLaunchPlan, inHerdr } from "../../src/pi/launch";

describe("inHerdr", () => {
  it("is true only when both herdr markers are set", () => {
    expect(inHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "p1" })).toBe(true);
    expect(inHerdr({ HERDR_ENV: "1" })).toBe(false);
    expect(inHerdr({ HERDR_PANE_ID: "p1" })).toBe(false);
    expect(inHerdr({})).toBe(false);
  });
});

describe("buildLaunchPlan", () => {
  it("creates a focused supervisor workspace at the target dir", () => {
    const plan = buildLaunchPlan("/tmp/repo");
    expect(plan.createArgs).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/tmp/repo",
      "--label",
      "mypi-supervisor",
      "--focus",
      "--env",
      "SHELL_SESSIONS_DISABLE=1",
    ]);
    expect(plan.paneCommand).toBe('pi; herdr pane close "$HERDR_PANE_ID"');
  });

  it("default pane command stays byte-identical", () => {
    expect(buildLaunchPlan("/tmp/repo").paneCommand).toBe('pi; herdr pane close "$HERDR_PANE_ID"');
  });

  it("resume flag switches the pane command to the explicit --resume entry point", () => {
    const plan = buildLaunchPlan("/tmp/repo", "mypi-supervisor", true);
    expect(plan.paneCommand).toBe(
      'pi "/mypi-multi-agent --resume"; herdr pane close "$HERDR_PANE_ID"',
    );
  });
});
