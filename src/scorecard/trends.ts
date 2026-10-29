/**
 * Trends summary (issue #19): renders the aggregated mistake ranking from
 * quality/ledger.jsonl into quality/trends.md. The smallest readable markdown
 * that names each taxonomyVersion's worst offenders first.
 */
import { writeFile } from "node:fs/promises";
import { readJsonl } from "../logging/conversation-log";
import { aggregate, type Trends } from "./aggregate";
import { sanitizeScorecard } from "./collector";
import type { RunScorecard } from "./scorecard";

export async function readLedger(ledgerPath: string): Promise<RunScorecard[]> {
  const out: RunScorecard[] = [];
  for (const record of await readJsonl(ledgerPath)) {
    const scorecard = sanitizeScorecard(record);
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
    if (version.attestation !== null) {
      const a = version.attestation;
      lines.push(
        `Attestation rounds: mean ${a.meanRounds.toFixed(3)} over ${a.cards} card(s), ${a.firstRoundFailed} with a failed first round.`,
        "",
      );
    }
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
