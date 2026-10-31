/**
 * Unit tests for the edit-miss hint extension.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { formatMissHint, nearestLine, toolResultHint } from "../../src/pi/tool-result-hint";

const NOT_FOUND =
  "Could not find the exact text in plan.md. The old text must match exactly including all whitespace and newlines.";

/** Capture the tool_result handler from a mock pi. */
function captureHandler() {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const pi = {
    on: vi.fn((event: string, h: (e: unknown) => Promise<unknown>) => {
      handlers.set(event, h);
      return () => {};
    }),
  } as unknown as ExtensionAPI;
  toolResultHint()(pi);
  const handler = handlers.get("tool_result");
  if (handler === undefined) throw new Error("no tool_result handler registered");
  return handler as (
    event: Partial<ToolResultEvent>,
  ) => Promise<{ content?: { type: string; text: string }[]; isError?: boolean } | undefined>;
}

function editEvent(overrides: Record<string, unknown> = {}): Partial<ToolResultEvent> {
  return {
    type: "tool_result",
    toolName: "edit",
    toolCallId: "c1",
    input: { path: "plan.md", oldText: "the wrapped fragment" },
    content: [{ type: "text", text: NOT_FOUND }],
    isError: true,
    ...overrides,
  } as Partial<ToolResultEvent>;
}

describe("nearestLine", () => {
  it("scores the line that shares the longest token run", () => {
    const file = ["alpha beta", "the wrapped fragment of prose", "gamma delta"];
    expect(nearestLine(file, "the wrapped fragment of prose that wrapped")).toEqual({
      index: 1,
      shared: 5,
    });
  });

  it("returns null when no line shares enough tokens", () => {
    expect(nearestLine(["alpha beta gamma", "delta epsilon"], "zulu yankee xray")).toBeNull();
  });
});

describe("formatMissHint", () => {
  it("points at the line a wrapped oldText drifted from", () => {
    const file = [
      "# Plan",
      "",
      "intro",
      '    - "canary duty applies only when a regression test was added"',
      "tail",
    ].join("\n");
    const hint = formatMissHint(file, "canary duty applies only when a regression test was\nadded");
    expect(hint).toContain("Nearest match is around line 4");
    expect(hint).toContain(">     4 |");
    expect(hint).toContain("canary duty applies");
  });

  it("returns undefined rather than guessing", () => {
    expect(formatMissHint("a\nb\nc\n", "nothing in common here at all")).toBeUndefined();
  });

  it("returns undefined for an empty oldText", () => {
    expect(formatMissHint("a\nb\n", "  \n ")).toBeUndefined();
  });

  it("keeps the hint under its cap without cutting a line", () => {
    const long = "the wrapped fragment of prose ".repeat(12);
    const file = Array.from(
      { length: 40 },
      (_v, i) => `${i === 20 ? long : `line ${i} filler text here`}`,
    ).join("\n");
    const hint = formatMissHint(file, long) ?? "";
    expect(hint.length).toBeLessThanOrEqual(900);
    expect(hint).toContain(">    21 |");
    for (const row of hint.split("\n").slice(1)) expect(row.length).toBeLessThanOrEqual(260);
    expect(hint.endsWith("…")).toBe(false);
  });
});

describe("toolResultHint", () => {
  let dir: string;
  let planPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mypi-hint-"));
    planPath = join(dir, "plan.md");
    await writeFile(
      planPath,
      ["# Plan", "", "- The attester must name the evidence for each criterion.", "", "tail"].join(
        "\n",
      ),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends the nearest region and keeps the original error", async () => {
    const handler = captureHandler();
    const result = await handler(
      editEvent({
        input: {
          path: planPath,
          oldText: "The attester must name the evidence for\n    each criterion.",
        },
      }),
    );
    expect(result?.content?.[0]?.text).toBe(NOT_FOUND);
    expect(result?.content?.at(-1)?.text).toContain("Nearest match is around line 3");
    expect(result?.isError).toBeUndefined();
  });

  it("uses the edits[N] oldText for a batch refusal", async () => {
    const handler = captureHandler();
    const result = await handler(
      editEvent({
        input: {
          path: planPath,
          edits: [
            { oldText: "no such text anywhere", newText: "x" },
            { oldText: "The attester must name the evidence", newText: "x" },
          ],
        },
        content: [
          {
            type: "text",
            text: "Could not find edits[1] in plan.md. The oldText must match exactly including all whitespace and newlines.",
          },
        ],
      }),
    );
    expect(result?.content?.at(-1)?.text).toContain("Nearest match is around line 3");
  });

  it("ignores a successful edit", async () => {
    const handler = captureHandler();
    expect(await handler(editEvent({ isError: false }))).toBeUndefined();
  });

  it("ignores other tools and other errors", async () => {
    const handler = captureHandler();
    expect(await handler(editEvent({ toolName: "read" }))).toBeUndefined();
    expect(
      await handler(
        editEvent({
          content: [{ type: "text", text: "Found 2 occurrences of the text in plan.md." }],
        }),
      ),
    ).toBeUndefined();
  });

  it("stays silent when the file is gone", async () => {
    const handler = captureHandler();
    expect(
      await handler(
        editEvent({ input: { path: join(dir, "missing.md"), oldText: "the wrapped fragment" } }),
      ),
    ).toBeUndefined();
  });
});
