/**
 * Scorecard I/O seam: reads run-details artifacts (conversation.jsonl,
 * tool-calls.jsonl, final.md frontmatter) into the pure buildScorecard inputs,
 * and writes run-details/scorecard.json. The only impure scorecard code.
 *
 * The seam owns the privacy boundary (issue #20): the outcome is normalized to the
 * fixed enum and final.md agent names outside the config allowlist are dropped, so
 * no consumer of collectArtifacts can observe raw artifact text.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readJsonl } from "../logging/conversation-log";
import {
  buildScorecard,
  normalizeOutcome,
  type RunScorecard,
  type ScorecardArtifacts,
  type ScorecardFinal,
} from "./scorecard";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Extract and parse the YAML frontmatter between the leading `---` fences. */
function parseFrontmatter(md: string): Record<string, unknown> | undefined {
  const match = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!match) return undefined;
  const parsed = parseYaml(match[1] ?? "");
  return isRecord(parsed) ? parsed : undefined;
}

const finiteNum = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const stringOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toScorecardFinal(
  fm: Record<string, unknown> | undefined,
  agentIds: readonly string[],
): ScorecardFinal {
  const allowed = new Set(agentIds);
  const agentCosts: ScorecardFinal["agentCosts"] = [];
  const rawAgents = fm?.agents;
  if (Array.isArray(rawAgents)) {
    for (const a of rawAgents) {
      if (!isRecord(a)) continue;
      const name = stringOrNull(a.name);
      // Allowlist at the seam: a name in final.md that the config does not name is
      // artifact free text and never reaches a consumer (issue #20).
      if (name === null || !allowed.has(name)) continue;
      agentCosts.push({
        name,
        costUsd: finiteNum(a.cost_usd) ?? 0,
        tokens: finiteNum(a.tokens) ?? 0,
      });
    }
  }
  return {
    // Normalized here, not just in buildScorecard, so no collectArtifacts consumer
    // ever sees the raw status text (issue #20).
    outcome: normalizeOutcome(stringOrNull(fm?.status)),
    exitCode: finiteNum(fm?.exit_code),
    totalCostUsd: finiteNum(fm?.total_cost_usd),
    totalTokens: finiteNum(fm?.total_tokens),
    supervisorCostUsd: finiteNum(fm?.supervisor_cost_usd),
    supervisorTokens: finiteNum(fm?.supervisor_tokens),
    agentCosts,
  };
}

/**
 * Read already-written run artifacts into pure inputs. Missing files become
 * empty/null. `agentIds` is the config allowlist: final.md agent names outside it
 * are dropped at the seam, and the status is normalized to the fixed outcome enum.
 */
export async function collectArtifacts(
  runDetailsDir: string,
  agentIds: readonly string[],
): Promise<ScorecardArtifacts> {
  const [conversation, toolCalls, finalMd] = await Promise.all([
    readJsonl(join(runDetailsDir, "conversation.jsonl")),
    readJsonl(join(runDetailsDir, "tool-calls.jsonl")),
    readFile(join(runDetailsDir, "final.md"), "utf8").catch(() => ""),
  ]);
  return { conversation, toolCalls, final: toScorecardFinal(parseFrontmatter(finalMd), agentIds) };
}

/** Build and write run-details/scorecard.json. */
export async function writeScorecard(
  runDetailsDir: string,
  scorecard: RunScorecard,
): Promise<void> {
  await writeFile(join(runDetailsDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
}

/** Convenience: collect + build in one call (used by the finalize hook). */
export async function recordScorecard(
  runDetailsDir: string,
  config: Parameters<typeof buildScorecard>[1],
): Promise<RunScorecard> {
  const artifacts = await collectArtifacts(
    runDetailsDir,
    config.agents.map((a) => a.id),
  );
  const scorecard = buildScorecard(artifacts, config);
  await writeScorecard(runDetailsDir, scorecard);
  return scorecard;
}
