/**
 * Unit tests for the pre-spawn model preflight and duplicate-slug helpers.
 */
import { describe, expect, it, vi } from "vitest";
import {
  duplicateModelSlugs,
  findUnusableModels,
  type ModelLookup,
} from "../../src/pi/model-preflight";

/** A fake registry: `catalog` maps "provider/model" -> object, `authed` marks which are usable. */
function fakeRegistry(
  catalog: Record<string, object>,
  authed: Set<string> = new Set(Object.keys(catalog)),
): ModelLookup<object> & { find: ReturnType<typeof vi.fn> } {
  return {
    find: vi.fn((provider: string, model: string) => catalog[`${provider}/${model}`]),
    hasConfiguredAuth: (m: object) => authed.has((m as { slug: string }).slug),
  } as unknown as ModelLookup<object> & { find: ReturnType<typeof vi.fn> };
}

describe("findUnusableModels", () => {
  it("returns nothing for resolvable, authorized models", () => {
    const r = fakeRegistry({ "a/one": { slug: "a/one" } });
    expect(findUnusableModels(r, [{ id: "p1", model: "a/one" }])).toEqual([]);
  });

  it("flags a malformed slug that has no provider/model split", () => {
    const r = fakeRegistry({});
    expect(findUnusableModels(r, [{ id: "p1", model: "noslash" }])).toEqual([
      { agentId: "p1", model: "noslash", reason: expect.stringContaining("malformed") },
    ]);
  });

  it("flags a slug that is not in the catalog", () => {
    const r = fakeRegistry({});
    expect(findUnusableModels(r, [{ id: "p1", model: "a/missing" }])).toEqual([
      { agentId: "p1", model: "a/missing", reason: expect.stringContaining("catalog") },
    ]);
  });

  it("flags a resolvable slug whose provider has no configured auth", () => {
    const r = fakeRegistry({ "a/one": { slug: "a/one" } }, new Set());
    expect(findUnusableModels(r, [{ id: "p1", model: "a/one" }])).toEqual([
      { agentId: "p1", model: "a/one", reason: expect.stringContaining("auth") },
    ]);
  });

  it("reports one entry per agent but resolves each distinct slug once", () => {
    const r = fakeRegistry({ "b/ok": { slug: "b/ok" } });
    const out = findUnusableModels(r, [
      { id: "p1", model: "a/missing" },
      { id: "p2", model: "a/missing" },
      { id: "p3", model: "b/ok" },
    ]);
    expect(out.map((u) => u.agentId)).toEqual(["p1", "p2"]);
    expect(r.find).toHaveBeenCalledTimes(2); // a/missing once, b/ok once
  });
});

describe("duplicateModelSlugs", () => {
  it("returns nothing when every slug is distinct", () => {
    expect(
      duplicateModelSlugs([
        { id: "p1", model: "a/one" },
        { id: "p2", model: "a/two" },
      ]),
    ).toEqual([]);
  });

  it("groups agents that share a slug", () => {
    expect(
      duplicateModelSlugs([
        { id: "p1", model: "a/one" },
        { id: "p2", model: "a/one" },
        { id: "p3", model: "b/two" },
      ]),
    ).toEqual([{ model: "a/one", agentIds: ["p1", "p2"] }]);
  });

  it("lists all three agents when a slug is shared three ways", () => {
    expect(
      duplicateModelSlugs([
        { id: "p1", model: "a/one" },
        { id: "p2", model: "a/one" },
        { id: "p3", model: "a/one" },
      ]),
    ).toEqual([{ model: "a/one", agentIds: ["p1", "p2", "p3"] }]);
  });
});
