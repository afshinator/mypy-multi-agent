/**
 * Scorecard I/O seam: reads run-details artifacts (conversation.jsonl,
 * tool-calls.jsonl, final.md frontmatter) into the pure buildScorecard inputs,
 * and writes run-details/scorecard.json. The only impure scorecard code.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildScorecard,
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

function toScorecardFinal(fm: Record<string, unknown> | undefined): ScorecardFinal {
  const agentCosts: ScorecardFinal["agentCosts"] = [];
  const rawAgents = fm?.agents;
  if (Array.isArray(rawAgents)) {
    for (const a of rawAgents) {
      if (!isRecord(a)) continue;
      const name = stringOrNull(a.name);
      if (name === null) continue;
      agentCosts.push({
        name,
        costUsd: finiteNum(a.cost_usd) ?? 0,
        tokens: finiteNum(a.tokens) ?? 0,
      });
    }
  }
  return {
    outcome: stringOrNull(fm?.status),
    exitCode: finiteNum(fm?.exit_code),
    totalCostUsd: finiteNum(fm?.total_cost_usd),
    totalTokens: finiteNum(fm?.total_tokens),
    supervisorCostUsd: finiteNum(fm?.supervisor_cost_usd),
    supervisorTokens: finiteNum(fm?.supervisor_tokens),
    agentCosts,
  };
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // A malformed line is skipped; the scorecard is derived from what parsed.
    }
  }
  return out;
}

/** Read already-written run artifacts into pure inputs. Missing files become empty/null. */
export async function collectArtifacts(runDetailsDir: string): Promise<ScorecardArtifacts> {
  const [conversation, toolCalls, finalMd] = await Promise.all([
    readJsonl(join(runDetailsDir, "conversation.jsonl")),
    readJsonl(join(runDetailsDir, "tool-calls.jsonl")),
    readFile(join(runDetailsDir, "final.md"), "utf8").catch(() => ""),
  ]);
  return { conversation, toolCalls, final: toScorecardFinal(parseFrontmatter(finalMd)) };
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
): Promise<void> {
  const artifacts = await collectArtifacts(runDetailsDir);
  await writeScorecard(runDetailsDir, buildScorecard(artifacts, config));
}
