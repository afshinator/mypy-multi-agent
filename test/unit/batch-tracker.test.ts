/**
 * Unit tests for the batch tracker adapter. The fake `Exec` records argv and
 * the stdin it was handed, so the tests pin the exact gh calls: the comment id
 * must be the numeric REST id (a GraphQL node id cannot be PATCHed), and the
 * issue body must never be written.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AI_DISCLAIMER,
  commentBody,
  createGithubTracker,
  findMarker,
} from "../../src/batch/tracker";

const DISCLAIMER = AI_DISCLAIMER;
const marker = "<!-- mypi-batch:2026-11-01-a:163 -->";

const TICKET = JSON.stringify({
  number: 163,
  title: "Fold the closing record into the gate",
  body: "original body",
  state: "OPEN",
  updatedAt: "2026-10-31T20:07:03Z",
  labels: [{ name: "enhancement" }, { name: "ready-for-agent" }],
});
const COMMENTS = JSON.stringify([
  { id: 6562651430, body: `${DISCLAIMER}\n\n${marker}\nTask type: code-fix` },
  { id: 6562797344, body: "Implemented and landed." },
]);

function fakeExec(responses: Record<string, string>) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const exec = vi.fn(async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    // First three tokens distinguish the calls: issue view, api <path>, api --method.
    const key = args.slice(0, 3).join(" ");
    for (const [match, out] of Object.entries(responses)) if (key.includes(match)) return out;
    return "";
  });
  return { exec, calls };
}

describe("findMarker", () => {
  it("finds the comment carrying the marker and ignores others", () => {
    expect(
      findMarker(
        [
          { id: 1, body: "hi" },
          { id: 2, body: `${marker}\nx` },
        ],
        marker,
      ),
    ).toBe(2);
    expect(findMarker([{ id: 1, body: "hi" }], marker)).toBeUndefined();
  });
});

describe("commentBody", () => {
  it("puts the disclaimer first and the marker exactly once", () => {
    const body = commentBody(marker, "Task type: code-fix\n\nDoD:\n- one");
    expect(body.startsWith(DISCLAIMER)).toBe(true);
    expect(body.split(marker)).toHaveLength(2);
    expect(body).toContain("Task type: code-fix");
  });
});

describe("createGithubTracker", () => {
  const tracker = () =>
    fakeExec({
      "issue view 163": TICKET,
      "api repos/{owner}/{repo}/issues/163/comments": COMMENTS,
    });

  it("reads one ticket with patchable numeric comment ids", async () => {
    const { exec, calls } = tracker();
    const ticket = await createGithubTracker(exec).view(163);
    expect(ticket).toMatchObject({
      number: 163,
      state: "OPEN",
      labels: ["enhancement", "ready-for-agent"],
    });
    expect(ticket.comments).toEqual([
      { id: 6562651430, body: `${DISCLAIMER}\n\n${marker}\nTask type: code-fix` },
      { id: 6562797344, body: "Implemented and landed." },
    ]);
  });

  it("edits the existing marker comment by numeric id", async () => {
    const { exec, calls } = tracker();
    const result = await createGithubTracker(exec).upsertMarkerComment(163, marker, "new text");
    expect(result).toEqual({ action: "edited", id: 6562651430 });
    const write = calls.find((c) => c.args.includes("PATCH"));
    expect(write?.args).toEqual([
      "api",
      "--method",
      "PATCH",
      "repos/{owner}/{repo}/issues/comments/6562651430",
      "-f",
      "body=@-",
    ]);
    expect(write?.stdin?.startsWith(DISCLAIMER)).toBe(true);
    expect(write?.stdin).toContain(marker);
  });

  it("creates the comment when no marker exists", async () => {
    const { exec, calls } = fakeExec({
      "issue view 163": TICKET,
      "api repos/{owner}/{repo}/issues/163/comments": JSON.stringify([
        { id: 1, body: "unrelated" },
      ]),
      "api --method POST": JSON.stringify({ id: 7000000001 }),
    });
    const result = await createGithubTracker(exec).upsertMarkerComment(163, marker, "text");
    expect(result).toEqual({ action: "created", id: 7000000001 });
    const write = calls.find((c) => c.args.includes("POST"));
    expect(write?.args).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/issues/163/comments",
      "-f",
      "body=@-",
    ]);
  });

  it("adds and removes exactly one label, and never the body", async () => {
    const { exec, calls } = fakeExec({});
    const t = createGithubTracker(exec);
    await t.addLabel(163, "ready-for-agent");
    await t.removeLabel(163, "needs-info");
    expect(calls.map((c) => c.args)).toEqual([
      ["issue", "edit", "163", "--add-label", "ready-for-agent"],
      ["issue", "edit", "163", "--remove-label", "needs-info"],
    ]);
    for (const call of calls) {
      expect(call.args).not.toContain("--body");
      expect(call.args).not.toContain("-b");
      expect(call.args).not.toContain("--body-file");
    }
  });

  it("surfaces a gh failure as a named error", async () => {
    const exec = vi.fn(async () => {
      throw new Error("gh: Not Found (HTTP 404)");
    });
    await expect(createGithubTracker(exec).view(999)).rejects.toThrow(/Not Found/);
  });
});
