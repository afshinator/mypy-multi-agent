/**
 * Blinded adjudication packets.
 *
 * In the re-measurement both peers read the same rows with `tool`, `rule_id` and the
 * rule's own message in front of them, and split on 20 of 49 rows along rule families:
 * one rejected every scored complexity rule, the other verified every one. This removes
 * the identity half of that bias mechanically — the row carries a salted hash instead of
 * an id that spells `fallow:crap:path:line`, and no tool or rule name at all.
 *
 * It does not remove the family half. 16 of 25 families name themselves in their own
 * message text ("Python file is not formatted correctly", "Import block is un-sorted"),
 * and a claim cannot be stripped without deleting the thing being judged. Treat a blinded
 * verdict as free of *identity* bias only.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BlindRow {
  /** Salted hash of the original finding id: stable for one salt, not reversible. */
  id: string;
  path: string;
  line: number | null;
  /** The claim exactly as the analyzer made it. */
  claim: string;
}

export interface BlindPacket {
  salt: string;
  rows: BlindRow[];
  /** hash -> original finding id. Never shown to an adjudicator. */
  key: Record<string, string>;
}

export interface BlindableFinding {
  id: string;
  path: string;
  line: number | null;
  message: string;
  rule_id?: string | null;
}

/**
 * Some analyzers write their own rule id into the message ("unlisted_dependencies: ...").
 * Removing that occurrence leaves the proposition intact; the family is still inferable
 * from the remaining words, which is the limit documented above.
 */
export function redactRuleIds(claim: string, ruleIds: (string | null | undefined)[]): string {
  let out = claim;
  for (const rule of ruleIds) {
    if (typeof rule !== "string" || rule.length < 3) continue;
    out = out.split(rule).join("");
  }
  return out
    .replace(/^[\s:—-]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const hashId = (salt: string, id: string): string =>
  createHash("sha256").update(`${salt}\u0000${id}`).digest("hex").slice(0, 16);

/** Build the packet an adjudicator sees, plus the join key kept out of its sight. */
export function blindFindings(findings: BlindableFinding[], salt: string): BlindPacket {
  const rows: BlindRow[] = [];
  const key: Record<string, string> = {};
  for (const finding of findings) {
    const id = hashId(salt, finding.id);
    key[id] = finding.id;
    rows.push({
      id,
      path: finding.path,
      line: finding.line,
      claim: redactRuleIds(finding.message, [finding.rule_id]),
    });
  }
  return { salt, rows, key };
}

/** Serialise for a peer: rows only. The key must go to a different file, or elsewhere. */
export function packetForPeer(packet: BlindPacket): string {
  return `${JSON.stringify({ rows: packet.rows }, null, 2)}\n`;
}

export function assertNotBlindable(packet: BlindPacket, secrets: string[]): string[] {
  const serialised = JSON.stringify(packet.rows);
  return secrets.filter((s) => s.length > 2 && serialised.includes(s));
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const findingsPath = arg("--findings");
  const outPath = arg("--out");
  const keyPath = arg("--key");
  const salt = arg("--salt");
  if (!findingsPath || !outPath || !keyPath || !salt) {
    console.error("blind: --findings <json> --out <peer-packet> --key <hidden-key> --salt <s>");
    process.exit(2);
  }
  const findings = JSON.parse(readFileSync(findingsPath, "utf8")) as BlindableFinding[];
  const packet = blindFindings(findings, salt);
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(outPath, packetForPeer(packet));
  writeFileSync(keyPath, `${JSON.stringify(packet.key, null, 2)}\n`);
  console.log(`blind: ${packet.rows.length} rows -> ${outPath} (key in ${keyPath})`);
}
