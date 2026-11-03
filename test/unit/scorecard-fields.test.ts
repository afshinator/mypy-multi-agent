/**
 * One declaration of a card's fields. The allowlist that writes a ledger line is
 * derived from it, so a field cannot exist on the card and quietly vanish from
 * the ledger.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CARD_FIELDS, sanitizeCard } from "../../src/scorecard/fields";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One valid value per declared field: a field the table cannot carry fails here. */
const FULL = {
  taxonomyVersion: "2.0",
  task: "mypi-tasks/05",
  attestationRounds: 2,
  firstAttestationRoundFailed: true,
  outcome: "success",
  exitCode: 0,
  outcomeExitMismatch: false,
  dod: "met",
  falseSuccess: false,
  turnDurationsMs: { peer1: [10] },
  toolTimeMs: 10,
  toolTimeByAgentMs: { peer1: 10 },
  toolCalls: 3,
  toolErrors: 0,
  retries: 1,
  correlationTimeouts: 0,
  agentCrashed: 0,
  agentUnusable: 0,
  agentStalled: 0,
  stopAgentReasons: { complete: 2 },
  cost: {
    totalCostUsd: 1,
    totalTokens: 10,
    supervisorCostUsd: 0.5,
    supervisorTokens: 5,
    agents: [{ agentId: "peer1", costUsd: 0.5, tokens: 5 }],
  },
  modelRoster: ["m"],
  mistakes: [{ class: "M1", detail: "d" }],
};

describe("the field declaration", () => {
  it("covers every field, with nothing hand-listed outside it", () => {
    expect(Object.keys(FULL).sort()).toEqual(CARD_FIELDS.map((f) => f.name).sort());
  });

  it("returns every declared field it is given", () => {
    expect(Object.keys(sanitizeCard(FULL) ?? {}).sort()).toEqual(Object.keys(FULL).sort());
  });

  it("keeps a value equal to what was written for every field", () => {
    const card = sanitizeCard(FULL) as unknown as Record<string, unknown>;
    const written = FULL as unknown as Record<string, unknown>;
    for (const field of CARD_FIELDS) expect(card[field.name]).toEqual(written[field.name]);
  });

  it("treats an absent optional field as not recorded, not as zero", () => {
    const { attestationRounds, firstAttestationRoundFailed, task, ...rest } = FULL;
    const card = sanitizeCard(rest);
    expect(card).not.toBeNull();
    expect("attestationRounds" in card!).toBe(false);
    expect("task" in card!).toBe(false);
  });

  it("refuses a card that is missing a required field", () => {
    const { toolCalls, ...rest } = FULL;
    expect(sanitizeCard(rest)).toBeNull();
  });

  it("drops a field that is not declared, so the ledger stays an allowlist", () => {
    const card = sanitizeCard({ ...FULL, transcript: "secret" });
    expect(card).not.toBeNull();
    expect("transcript" in card!).toBe(false);
  });

  it("still collects rows written before this change — no schema bump needed", () => {
    // Committed rows copied from a real ledger: `quality/ledger.jsonl` is local
    // only, so a test that reads it passes here and fails in CI (which is how this
    // was caught).
    const fixture = readFileSync(join(repoRoot, "test/fixtures/scorecard/ledger-v1.jsonl"), "utf8");
    const rows = fixture.split("\n").filter((line) => line.trim() !== "");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(sanitizeCard(JSON.parse(row))).not.toBeNull();
  });

  it("collects the local ledger too, when this machine has one", () => {
    const local = join(repoRoot, "quality/ledger.jsonl");
    if (!existsSync(local)) return;
    for (const row of readFileSync(local, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")) {
      expect(sanitizeCard(JSON.parse(row))).not.toBeNull();
    }
  });
});
