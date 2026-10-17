/**
 * Unit tests for the scorecard I/O seam: collectArtifacts and writeScorecard.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSessionConfig } from "../../src/contracts/session-schema";
import { collectArtifacts, writeScorecard } from "../../src/scorecard/record";
import { buildScorecard } from "../../src/scorecard/scorecard";

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

const finalMd = (decision: string) => `---
status: success
exit_code: 0
total_cost_usd: 1.25
total_tokens: 4200
supervisor_cost_usd: 0.25
supervisor_tokens: 200
agents:
  - name: a1
    cost_usd: 1.0
    tokens: 4000
---
## Decision

${decision}
`;

describe("collectArtifacts", () => {
  it("reads conversation, tool-calls and final frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scorecard-"));
    try {
      await writeFile(
        join(dir, "conversation.jsonl"),
        `${JSON.stringify({ type: "RETRY", timestamp: 1 })}\n`,
      );
      await writeFile(
        join(dir, "tool-calls.jsonl"),
        `${JSON.stringify({ agentId: "a1", durationMs: 42, isError: false })}\n`,
      );
      await writeFile(join(dir, "final.md"), finalMd("decided"));

      const artifacts = await collectArtifacts(dir, ["a1"]);
      expect(artifacts.conversation).toHaveLength(1);
      expect(artifacts.toolCalls).toHaveLength(1);
      expect(artifacts.final).toEqual({
        outcome: "success",
        exitCode: 0,
        totalCostUsd: 1.25,
        totalTokens: 4200,
        supervisorCostUsd: 0.25,
        supervisorTokens: 200,
        agentCosts: [{ name: "a1", costUsd: 1.0, tokens: 4000 }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing tool-calls.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scorecard-"));
    try {
      await writeFile(join(dir, "final.md"), finalMd("decided"));
      const artifacts = await collectArtifacts(dir, ["a1"]);
      expect(artifacts.toolCalls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a missing final.md with null frontmatter fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scorecard-"));
    try {
      const artifacts = await collectArtifacts(dir, ["a1"]);
      expect(artifacts.final).toEqual({
        outcome: null,
        exitCode: null,
        totalCostUsd: null,
        totalTokens: null,
        supervisorCostUsd: null,
        supervisorTokens: null,
        agentCosts: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("boundary: the final decision body never reaches the scorecard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scorecard-"));
    try {
      const S_DECISION = "SENTINEL_DECISION_3f6a9d";
      await writeFile(
        join(dir, "conversation.jsonl"),
        `${JSON.stringify({
          type: "FINAL_REPORT",
          sender: "a1",
          recipient: "supervisor",
          timestamp: 1,
          payload: {
            agentId: "a1",
            report: "done",
            criteria: [{ criterion: "dod", result: "pass", evidence: "e" }],
          },
        })}\n`,
      );
      await writeFile(join(dir, "final.md"), finalMd(`decided to ${S_DECISION}`));

      const artifacts = await collectArtifacts(dir, ["a1"]);
      const json = JSON.stringify(artifacts);
      expect(json).not.toContain(S_DECISION);
      const sc = buildScorecard(artifacts, config);
      expect(JSON.stringify(sc)).not.toContain(S_DECISION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("boundary: normalizes foreign status text and drops unconfigured agent names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scorecard-"));
    try {
      const S_STATUS = "SENTINEL_STATUS_1b3a5c";
      const S_AGENT = "SENTINEL_AGENT_4e8f1a";
      await writeFile(
        join(dir, "final.md"),
        `---
status: ${S_STATUS}
exit_code: 1
total_cost_usd: 0.5
total_tokens: 10
supervisor_cost_usd: 0.1
supervisor_tokens: 2
agents:
  - name: ${S_AGENT}
    cost_usd: 0.4
    tokens: 8
  - name: a1
    cost_usd: 0.1
    tokens: 2
---
`,
      );

      const artifacts = await collectArtifacts(dir, ["a1"]);
      expect(artifacts.final.outcome).toBe("unknown");
      expect(artifacts.final.agentCosts).toEqual([{ name: "a1", costUsd: 0.1, tokens: 2 }]);
      expect(JSON.stringify(artifacts)).not.toContain(S_STATUS);
      expect(JSON.stringify(artifacts)).not.toContain(S_AGENT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeScorecard", () => {
  it("writes parseable scorecard.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scorecard-"));
    try {
      const sc = buildScorecard(
        {
          conversation: [],
          toolCalls: [],
          final: {
            outcome: null,
            exitCode: null,
            totalCostUsd: null,
            totalTokens: null,
            supervisorCostUsd: null,
            supervisorTokens: null,
            agentCosts: [],
          },
        },
        config,
      );
      await writeScorecard(dir, sc);
      const raw = await readFile(join(dir, "scorecard.json"), "utf8");
      expect(JSON.parse(raw)).toEqual(sc);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
