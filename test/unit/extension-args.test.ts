/**
 * Unit tests for the /mypi-multi-agent launch-argument parsing (issue #33).
 * The command handler is plumbing; this is the decision it used to bury inline.
 */
import { describe, expect, it } from "vitest";
import { parseLaunchArgs } from "../../src/pi/extension";

describe("parseLaunchArgs", () => {
  it("empty input runs the default task", () => {
    expect(parseLaunchArgs("")).toEqual({ resume: false, arg: "", taskName: "task" });
  });

  it("a bare name is both the task and the .mypi lookup", () => {
    expect(parseLaunchArgs("r1-fixes")).toEqual({
      resume: false,
      arg: "r1-fixes",
      taskName: "r1-fixes",
    });
  });

  it("--resume alone parses with no argument", () => {
    expect(parseLaunchArgs("--resume")).toEqual({ resume: true, arg: "", taskName: "task" });
  });

  it("--resume with a task name", () => {
    expect(parseLaunchArgs("--resume r1-fixes")).toEqual({
      resume: true,
      arg: "r1-fixes",
      taskName: "r1-fixes",
    });
  });

  it("--resume with extra whitespace trims the argument", () => {
    expect(parseLaunchArgs("--resume   r1-fixes  ")).toEqual({
      resume: true,
      arg: "r1-fixes",
      taskName: "r1-fixes",
    });
  });

  it("a path is an explicit file, so the scaffold task name stays generic", () => {
    expect(parseLaunchArgs("path/to/session.yaml")).toEqual({
      resume: false,
      arg: "path/to/session.yaml",
      taskName: "task",
    });
    expect(parseLaunchArgs("session.yaml").taskName).toBe("task");
    expect(parseLaunchArgs(".mypi/t/session.yml").taskName).toBe("task");
  });

  it("a flag-shaped typo is not treated as --resume", () => {
    expect(parseLaunchArgs("--resumeX")).toEqual({
      resume: false,
      arg: "--resumeX",
      taskName: "--resumeX",
    });
  });
});
