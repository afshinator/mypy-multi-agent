/**
 * Unit tests for the shared mypi-multi-agent.yaml parser (issue #56).
 * The parser is pure: text in, { version, taskDirs } out, no fs.
 */
import { describe, expect, it } from "vitest";
import { parseMultiAgentConfig } from "../../shared/parse-multi-agent-config";

describe("parseMultiAgentConfig", () => {
  it("parses a single-entry config", () => {
    expect(parseMultiAgentConfig("version: 1\ntaskDirs:\n  - mypi-tasks\n")).toEqual({
      version: 1,
      taskDirs: ["mypi-tasks"],
    });
  });

  it("parses a multi-entry config in order", () => {
    expect(parseMultiAgentConfig("version: 1\ntaskDirs:\n  - mypi-tasks\n  - .mypi\n")).toEqual({
      version: 1,
      taskDirs: ["mypi-tasks", ".mypi"],
    });
  });

  it("rejects an unknown version", () => {
    expect(() => parseMultiAgentConfig("version: 2\ntaskDirs:\n  - mypi-tasks\n")).toThrow(
      "version",
    );
  });

  it("rejects a missing version", () => {
    expect(() => parseMultiAgentConfig("taskDirs:\n  - mypi-tasks\n")).toThrow("version");
  });

  it("rejects an empty taskDirs", () => {
    expect(() => parseMultiAgentConfig("version: 1\ntaskDirs: []\n")).toThrow("taskDirs");
  });

  it("rejects a non-list taskDirs", () => {
    expect(() => parseMultiAgentConfig("version: 1\ntaskDirs: mypi-tasks\n")).toThrow("taskDirs");
  });

  it("rejects a non-string taskDirs entry", () => {
    expect(() => parseMultiAgentConfig("version: 1\ntaskDirs:\n  - 3\n")).toThrow("taskDirs");
  });

  it("rejects an empty-string taskDirs entry", () => {
    expect(() => parseMultiAgentConfig('version: 1\ntaskDirs:\n  - ""\n')).toThrow("taskDirs");
  });

  it("rejects malformed YAML", () => {
    expect(() =>
      parseMultiAgentConfig("version: 1\ntaskDirs:\n  - mypi-tasks\n  - [unclosed\n"),
    ).toThrow();
  });
});
