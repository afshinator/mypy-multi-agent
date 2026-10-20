/**
 * Unit tests for the /mypi-multi-agent launch-argument parsing (issues #33/#58).
 * The command handler is plumbing; this is the decision it used to bury inline.
 */
import { describe, expect, it } from "vitest";
import { parseLaunchArgs } from "../../src/pi/extension";

describe("parseLaunchArgs", () => {
  it("empty input runs the default task", () => {
    expect(parseLaunchArgs("")).toEqual({ resume: false, init: false, arg: "" });
  });

  it("a bare name is the task lookup", () => {
    expect(parseLaunchArgs("r1-fixes")).toEqual({
      resume: false,
      init: false,
      arg: "r1-fixes",
    });
  });

  it("--resume alone parses with no argument", () => {
    expect(parseLaunchArgs("--resume")).toEqual({ resume: true, init: false, arg: "" });
  });

  it("--resume with a task name", () => {
    expect(parseLaunchArgs("--resume r1-fixes")).toEqual({
      resume: true,
      init: false,
      arg: "r1-fixes",
    });
  });

  it("--resume with extra whitespace trims the argument", () => {
    expect(parseLaunchArgs("--resume   r1-fixes  ")).toEqual({
      resume: true,
      init: false,
      arg: "r1-fixes",
    });
  });

  it("--init alone parses with no argument", () => {
    expect(parseLaunchArgs("--init")).toEqual({ resume: false, init: true, arg: "" });
  });

  it("--init is recognized when --resume is not present", () => {
    expect(parseLaunchArgs("--init foo")).toEqual({ resume: false, init: true, arg: "foo" });
  });

  it("a path-shaped argument passes through as the task name", () => {
    expect(parseLaunchArgs("path/to/session.yaml")).toEqual({
      resume: false,
      init: false,
      arg: "path/to/session.yaml",
    });
  });

  it("a flag-shaped typo is not treated as --resume or --init", () => {
    expect(parseLaunchArgs("--resumeX")).toEqual({
      resume: false,
      init: false,
      arg: "--resumeX",
    });
  });
});
