/**
 * Collector tests (issue #19): opt-in boundary, append-only JSONL, privacy
 * allowlist, and the recordScorecard -> ledger round trip. All I/O goes through
 * os.tmpdir/mkdtemp; the real repo tree is never written.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { collect, sanitizeScorecard } from "../../src/scorecard/collector";
import { recordScorecard, writeScorecard } from "../../src/scorecard/record";
import type { RunScorecard } from "../../src/scorecard/scorecard";

// Spy on readFile for the non-access boundary assertion; every call still
// delegates to the real fs/promises readFile, so no I/O behavior changes.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const base: RunScorecard = {
  taxonomyVersion: "1.0",
  outcome: "success",
  exitCode: 0,
  outcomeExitMismatch: false,
  dod: "met",
  falseSuccess: false,
  turnDurationsMs: {},
  toolTimeMs: 0,
  toolTimeByAgentMs: {},
  toolCalls: 0,
  toolErrors: 0,
  retries: 0,
  correlationTimeouts: 0,
  agentCrashed: 0,
  agentUnusable: 0,
  agentStalled: 0,
  stopAgentReasons: {},
  cost: {
    totalCostUsd: null,
    totalTokens: null,
    supervisorCostUsd: null,
    supervisorTokens: null,
    agents: [],
  },
  modelRoster: [],
  mistakes: [],
};

const make = (over: Partial<RunScorecard> = {}): RunScorecard => ({
  ...base,
  ...over,
  cost: { ...base.cost, ...(over.cost ?? {}) },
});

const config = parseSessionConfig({
  version: "1.1",
  session: { id: "s1", max_cost_usd: 5, agent_stop_threshold_percent: 85, attester: "a1" },
  ask: { title: "t", description: "d", definition_of_done: ["dod"] },
  agents: [
    {
      id: "a1",
      title: "A",
      model: "m/a",
      permissions: { read: true, edit: false, shell: false },
      max_cost_usd: 1,
      system_prompt: "sp",
    },
  ],
});

const finalMd = `---
status: success
exit_code: 0
total_cost_usd: 1.0
total_tokens: 100
supervisor_cost_usd: 0.1
supervisor_tokens: 10
agents:
  - name: a1
    cost_usd: 0.9
    tokens: 90
---
## Decision
decided
`;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "collector-"));
  dirs.push(d);
  return d;
}

async function writeOptIn(dir: string, roots: string[]): Promise<string> {
  const p = join(dir, "opt-in.json");
  await writeFile(p, JSON.stringify(roots));
  return p;
}

async function writeScorecardFixture(root: string, scorecard: RunScorecard): Promise<void> {
  const rd = join(root, "run-details");
  await mkdir(rd, { recursive: true });
  await writeScorecard(rd, scorecard);
}

async function writeRawScorecard(root: string, obj: unknown): Promise<void> {
  const rd = join(root, "run-details");
  await mkdir(rd, { recursive: true });
  await writeFile(join(rd, "scorecard.json"), JSON.stringify(obj));
}

async function ledgerLines(p: string): Promise<string[]> {
  const raw = await readFile(p, "utf8");
  return raw.split("\n").filter((l) => l.trim() !== "");
}

describe("collect", () => {
  it("never reads a project root absent from the opt-in list", async () => {
    const repo = await tmp();
    const optIn = await writeOptIn(repo, []); // filled below with only `opted`
    const ledger = join(repo, "ledger.jsonl");

    const opted = await tmp();
    await writeScorecardFixture(opted, make());

    const sibling = await tmp();
    const SENTINEL = "SENTINEL_PROMPT_7c3f";
    await writeRawScorecard(sibling, {
      ...make(),
      prompt: `${SENTINEL}_prompt`,
      code: `${SENTINEL}_code`,
    });

    await writeFile(optIn, JSON.stringify([opted]));
    vi.mocked(readFile).mockClear();
    const results = await collect(optIn, ledger);

    expect(results).toHaveLength(1);
    expect(results[0]?.root).toBe(opted);
    expect(results[0]?.ok).toBe(true);

    const optedScorecardPath = join(opted, "run-details", "scorecard.json");
    const siblingScorecardPath = join(sibling, "run-details", "scorecard.json");
    const readScorecardPaths = vi
      .mocked(readFile)
      .mock.calls.map((call) => call[0])
      .filter((p): p is string => typeof p === "string" && p.endsWith("scorecard.json"));
    expect(readScorecardPaths).toEqual([optedScorecardPath]);
    expect(readScorecardPaths).not.toContain(siblingScorecardPath);

    const lines = await ledgerLines(ledger);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SENTINEL);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ ...make(), task: opted });
  });

  it("stamps the task from the opt-in entry, unless the card already names one", async () => {
    const repo = await tmp();
    const ledger = join(repo, "ledger.jsonl");

    const older = await tmp();
    await writeScorecardFixture(older, make());
    const own = await tmp();
    await writeScorecardFixture(own, make({ task: "mypi-tasks/its-own" }));

    const optIn = await writeOptIn(repo, [older, own]);
    await collect(optIn, ledger);

    const cards = (await ledgerLines(ledger)).map((l) => JSON.parse(l) as { task?: string });
    expect(cards[0]?.task).toBe(older);
    expect(cards[1]?.task).toBe("mypi-tasks/its-own");
  });

  it("appends: collecting twice keeps the first line byte-identical and adds a second", async () => {
    const repo = await tmp();
    const optIn = await writeOptIn(repo, []);
    const ledger = join(repo, "ledger.jsonl");

    const opted = await tmp();
    await writeScorecardFixture(opted, make({ mistakes: [{ class: "M1", detail: "stalled=1" }] }));
    await writeFile(optIn, JSON.stringify([opted]));

    await collect(optIn, ledger);
    const first = (await ledgerLines(ledger))[0] ?? "";

    await collect(optIn, ledger);
    const lines = await ledgerLines(ledger);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(first);
    expect(lines[1]).toBe(first);
  });

  it("keeps the task and the attestation metric, and still reads a card written without them", () => {
    // The cast is the point: a malformed metric is otherwise impossible to feed.
    const full = sanitizeScorecard({
      ...base,
      task: "mypi-tasks/post-mortem-03",
      attestationRounds: 2,
      firstAttestationRoundFailed: true,
    });
    expect(full?.task).toBe("mypi-tasks/post-mortem-03");
    expect(full?.attestationRounds).toBe(2);
    expect(full?.firstAttestationRoundFailed).toBe(true);

    // An older card has neither field: absence must survive as absence, not as 0.
    const older = sanitizeScorecard(base);
    expect(older).not.toBeNull();
    expect(older?.task).toBeUndefined();
    expect(older?.attestationRounds).toBeUndefined();

    // A malformed metric is dropped, never invented.
    const junk = sanitizeScorecard({ ...base, task: "", attestationRounds: "two" });
    expect(junk?.task).toBeUndefined();
    expect(junk?.attestationRounds).toBeUndefined();
  });

  it("privacy: no prompt/code/transcript/system-prompt/decision/evidence/report field reaches the ledger", async () => {
    const repo = await tmp();
    const optIn = await writeOptIn(repo, []);
    const ledger = join(repo, "ledger.jsonl");

    const opted = await tmp();
    const forbidden = {
      prompt: "P_sentinel",
      code: "C_sentinel",
      transcript: "T_sentinel",
      "system-prompt": "SP_sentinel",
      decision: "D_sentinel",
      evidence: "E_sentinel",
      report: "R_sentinel",
    };
    await writeRawScorecard(opted, { ...make(), ...forbidden });
    await writeFile(optIn, JSON.stringify([opted]));

    const results = await collect(optIn, ledger);
    expect(results[0]?.ok).toBe(true);

    const line = (await ledgerLines(ledger))[0] ?? "";
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const key of Object.keys(forbidden)) {
      expect(parsed, key).not.toHaveProperty(key);
    }
    expect(line).not.toContain("_sentinel");
    expect(parsed.taxonomyVersion).toBe("1.0");
  });

  it("round-trip: recordScorecard output is collected into the ledger verbatim (derived fields only)", async () => {
    const repo = await tmp();
    const optIn = await writeOptIn(repo, []);
    const ledger = join(repo, "ledger.jsonl");

    const project = await tmp();
    const runDetails = join(project, "run-details");
    await mkdir(runDetails, { recursive: true });
    await writeFile(join(runDetails, "conversation.jsonl"), "\n");
    await writeFile(join(runDetails, "tool-calls.jsonl"), "\n");
    await writeFile(join(runDetails, "final.md"), finalMd);
    // Production always passes the task; the round-trip must stay verbatim when it does.
    await recordScorecard(runDetails, config, "mypi-tasks/round-trip");

    const written = JSON.parse(
      await readFile(join(runDetails, "scorecard.json"), "utf8"),
    ) as RunScorecard;
    await writeFile(optIn, JSON.stringify([project]));

    const results = await collect(optIn, ledger);
    expect(results[0]?.ok).toBe(true);

    const line = (await ledgerLines(ledger))[0] ?? "";
    expect(JSON.parse(line)).toEqual(written);
  });
});
