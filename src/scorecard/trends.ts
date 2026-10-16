/**
 * Trends summary (issue #19): renders the aggregated mistake ranking from
 * quality/ledger.jsonl into quality/trends.md. The smallest readable markdown
 * that names each taxonomyVersion's worst offenders first.
 */
import { readFile, writeFile } from "node:fs/promises";
import { aggregate, type Trends } from "./aggregate";
import { sanitizeScorecard } from "./collector";
import type { RunScorecard } from "./scorecard";

export async function readLedger(ledgerPath: string): Promise<RunScorecard[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const out: RunScorecard[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const scorecard = sanitizeScorecard(parsed);
    if (scorecard !== null) out.push(scorecard);
  }
  return out;
}

export function renderTrends(trends: Trends): string {
  const lines: string[] = ["# Quality trends", "", `Scorecards: ${trends.scorecardCount}`, ""];
  for (const version of trends.byVersion) {
    lines.push(
      `## taxonomyVersion ${version.taxonomyVersion} (${version.scorecardCount} scorecard(s))`,
      "",
    );
    if (version.mistakes.length === 0) {
      lines.push("No mistakes recorded.", "");
      continue;
    }
    lines.push("| mistake | count | rate |", "| --- | --- | --- |");
    for (const m of version.mistakes) {
      lines.push(`| ${m.class} | ${m.count} | ${m.rate.toFixed(3)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeTrends(ledgerPath: string, outPath: string): Promise<void> {
  const trends = aggregate(await readLedger(ledgerPath));
  await writeFile(outPath, renderTrends(trends));
}

if (import.meta.main) {
  const [ledgerPath = "quality/ledger.jsonl", outPath = "quality/trends.md"] =
    process.argv.slice(2);
  await writeTrends(ledgerPath, outPath);
}
