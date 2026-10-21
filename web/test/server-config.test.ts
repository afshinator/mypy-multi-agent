/**
 * Server config parsing and path-containment gate (#70). These pure helpers are
 * node-free so vitest and `tsc` both cover them; the middleware layer is the
 * only place that touches `node:fs`/`node:path`/`node:os`.
 */
import { describe, expect, it } from "vitest";
import { parseServerConfig, resolveWithinRoot } from "../lib/server-config";

describe("parseServerConfig", () => {
  it("throws when the config is missing", () => {
    expect(() => parseServerConfig("", "/home/u")).toThrow(
      "inspector.yaml must define a string projectsDir",
    );
  });

  it("uses an explicit projectsDir", () => {
    expect(parseServerConfig("projectsDir: /opt/projects\n", "/home/u").projectsDir).toBe(
      "/opt/projects",
    );
  });

  it("expands a leading ~ to the home directory", () => {
    expect(parseServerConfig("projectsDir: ~\n", "/home/u").projectsDir).toBe("/home/u");
  });

  it("expands a leading ~/ path to the home directory", () => {
    expect(parseServerConfig("projectsDir: ~/work/runs\n", "/home/u").projectsDir).toBe(
      "/home/u/work/runs",
    );
  });

  it("throws when projectsDir is not a string", () => {
    expect(() => parseServerConfig("projectsDir: 42\n", "/home/u")).toThrow(
      "inspector.yaml must define a string projectsDir",
    );
  });
});

describe("resolveWithinRoot", () => {
  const root = "/home/u/Documents/dev";

  it("resolves an in-root relative path", () => {
    expect(resolveWithinRoot(root, "alpha/beta")).toBe("/home/u/Documents/dev/alpha/beta");
  });

  it("resolves an empty path to the root", () => {
    expect(resolveWithinRoot(root, "")).toBe("/home/u/Documents/dev");
  });

  it("resolves '.' to the root", () => {
    expect(resolveWithinRoot(root, ".")).toBe("/home/u/Documents/dev");
  });

  it("rejects a ../ escape", () => {
    expect(resolveWithinRoot(root, "../etc")).toBeNull();
  });

  it("rejects an absolute path escape", () => {
    expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
  });

  it("rejects a rooted backslash path", () => {
    expect(resolveWithinRoot(root, "\\\\etc\\\\passwd")).toBeNull();
  });

  it("rejects a nested traversal that leaves the root", () => {
    expect(resolveWithinRoot(root, "alpha/../../etc")).toBeNull();
  });

  it("accepts an in-root .. that stays inside the root", () => {
    expect(resolveWithinRoot(root, "alpha/../beta")).toBe("/home/u/Documents/dev/beta");
  });
});
