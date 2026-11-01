/**
 * Unit tests for the batch model preflight. The recorded outputs below were
 * captured from `pi --list-models <slug>` (2026-11-01); the fuzzy case matters
 * because the flag is a search: `openrouter/anthropic/claude-sonnet-4` returns
 * 4.5 and 4.6 rows but no exact row, and `loadSession` resolves with
 * `registry.find(provider, model)` (src/pi/model-preflight.ts), i.e. exactly.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveModels } from "../../src/batch/preflight";

const RECORDED = {
  exact: `provider           model                          context  max-out  thinking  images
commandcode        deepseek/deepseek-v4-pro       1M       16.4K    yes       no
deepseek           deepseek-v4-pro                1M       384K     yes       no
opencode           deepseek-v4-pro                1M       384K     yes       no
openrouter         deepseek/deepseek-v4-pro       1.0M     393.2K   yes       no
`,
  fuzzyOnly: `provider    model                        context  max-out  thinking  images
openrouter  anthropic/claude-sonnet-4.5  1M       64K      yes       yes
openrouter  anthropic/claude-sonnet-4.6  1M       128K     yes       yes
`,
  none: `No models matching "nosuchprovider/model-x"
`,
};

const execOf =
  (out: string) =>
  async (_args: string[]): Promise<string> =>
    out;

describe("resolveModels", () => {
  it("accepts a slug the registry can resolve exactly", async () => {
    const out = await resolveModels(["deepseek/deepseek-v4-pro"], execOf(RECORDED.exact));
    expect(out).toEqual([{ slug: "deepseek/deepseek-v4-pro", ok: true, matches: 1 }]);
  });

  it("rejects a fuzzy-only match, because the runtime resolves exactly", async () => {
    const out = await resolveModels(
      ["openrouter/anthropic/claude-sonnet-4"],
      execOf(RECORDED.fuzzyOnly),
    );
    expect(out[0]).toMatchObject({ ok: false, reason: "unknown-model" });
  });

  it("rejects when nothing matches", async () => {
    const out = await resolveModels(["nosuchprovider/model-x"], execOf(RECORDED.none));
    expect(out[0]).toMatchObject({
      slug: "nosuchprovider/model-x",
      ok: false,
      reason: "unknown-model",
    });
  });

  it("never reports ok when the CLI itself fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("spawn pi ENOENT");
    });
    const out = await resolveModels(["deepseek/deepseek-v4-pro"], exec);
    expect(out[0]).toMatchObject({ ok: false, reason: "cli-failed" });
  });

  it("resolves each distinct slug once and keeps input order", async () => {
    const exec = vi.fn(execOf(RECORDED.exact));
    const out = await resolveModels(
      ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro", "nosuchprovider/model-x"],
      exec,
    );
    expect(exec).toHaveBeenCalledTimes(2);
    expect(out.map((r) => r.slug)).toEqual(["deepseek/deepseek-v4-pro", "nosuchprovider/model-x"]);
  });

  it("treats a slug without a provider as unknown without calling the CLI", async () => {
    const exec = vi.fn(execOf(RECORDED.exact));
    const out = await resolveModels(["deepseek-v4-pro", "/leading-slash"], exec);
    expect(exec).not.toHaveBeenCalled();
    expect(out.every((r) => !r.ok && r.reason === "unknown-model")).toBe(true);
  });

  it("passes the slug as the search argument", async () => {
    const exec = vi.fn(execOf(RECORDED.exact));
    await resolveModels(["deepseek/deepseek-v4-pro"], exec);
    expect(exec).toHaveBeenCalledWith(["--list-models", "deepseek/deepseek-v4-pro"]);
  });
});
