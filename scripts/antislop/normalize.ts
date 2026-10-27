/**
 * Per-tool extraction: raw reporter output -> normalized findings.
 *
 * Each extractor is pure (text in, findings out) so it can be unit-tested against
 * saved raw output. Rule ids are preserved verbatim; the category is a separate,
 * auditable mapping used only for dedupe and reporting.
 */
import { dedupeKey, type Finding } from "./schema";

export type Extracted = {
  rule_id: string | null;
  category: Finding["category"];
  severity: Finding["severity"];
  path: string;
  line: number | null;
  message: string;
  json_pointer: string | null;
};

export type ToolVersion = { id: string; version: string };

const sev = (value: unknown): Finding["severity"] => {
  const s = String(value ?? "").toLowerCase();
  if (s === "error" || s === "critical") return "error";
  if (s === "warning" || s === "warn") return "warning";
  if (s === "info" || s === "note" || s === "advice") return "info";
  return "unknown";
};

/** biome category strings look like `lint/style/noNonNullAssertion`. */
function biomeCategory(category: string): Finding["category"] {
  if (category.startsWith("lint/style/") || category === "format") return "lint_style";
  if (category.startsWith("assist/")) return "lint_style";
  return "lint_correctness";
}

type Json = Record<string, unknown>;
const asArray = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseJson(raw: string, tool: string): Json {
  try {
    return JSON.parse(raw) as Json;
  } catch (error) {
    throw new Error(`${tool}: raw output is not JSON (${(error as Error).message})`);
  }
}

function extractBiome(raw: string): Extracted[] {
  const root = parseJson(raw, "biome");
  return asArray(root.diagnostics).map((d, i) => {
    const location = (d.location ?? {}) as Json;
    const start = (location.start ?? {}) as Json;
    const category = asString(d.category);
    return {
      rule_id: category === "" ? null : category,
      category: biomeCategory(category),
      severity: sev(d.severity),
      path: asString(location.path),
      line: asNumber(start.line),
      message: asString(d.message),
      json_pointer: `/diagnostics/${i}`,
    };
  });
}

function extractOxlint(raw: string): Extracted[] {
  const root = parseJson(raw, "oxlint");
  return asArray(root.diagnostics).map((d, i) => {
    const labels = asArray(d.labels);
    const span = ((labels[0] ?? {}) as Json).span as Json | undefined;
    const code = asString(d.code);
    const isUnused = /no-unused-vars|noUnusedVars/.test(code);
    return {
      rule_id: code === "" ? null : code,
      category: isUnused ? "dead_code_inline" : "lint_correctness",
      severity: sev(d.severity),
      path: asString(d.filename),
      line: asNumber(span?.line),
      message: asString(d.message),
      json_pointer: `/diagnostics/${i}`,
    };
  });
}

/** knip groups every issue type under the file it belongs to. */
function extractKnip(raw: string): Extracted[] {
  const root = parseJson(raw, "knip");
  const out: Extracted[] = [];
  asArray(root.issues).forEach((issue, issueIndex) => {
    const file = asString(issue.file);
    for (const key of Object.keys(issue)) {
      if (key === "file") continue;
      const entries = asArray(issue[key]);
      entries.forEach((entry, entryIndex) => {
        const name = asString(entry?.name) || asString(entry?.symbol) || asString(entry);
        const isCycle = key === "cycles";
        const isDup = key === "duplicates";
        out.push({
          rule_id: key,
          category: isCycle
            ? "dependency_cycle_boundary"
            : isDup
              ? "duplication"
              : "unused_file_export_dep",
          severity: "warning",
          path: file,
          line: asNumber(entry?.line),
          message: `${key}${name === "" ? "" : `: ${name}`}`,
          json_pointer: `/issues/${issueIndex}/${key}/${entryIndex}`,
        });
      });
    }
  });
  return out;
}

const FALLOW_CATEGORY: Record<string, Finding["category"]> = {
  unused_files: "unused_file_export_dep",
  unused_exports: "unused_file_export_dep",
  unused_types: "unused_file_export_dep",
  unused_dependencies: "unused_file_export_dep",
  unused_dev_dependencies: "unused_file_export_dep",
  unused_optional_dependencies: "unused_file_export_dep",
  unlisted_dependencies: "unused_file_export_dep",
  unresolved_imports: "unused_file_export_dep",
  duplicate_exports: "duplication",
  circular_dependencies: "dependency_cycle_boundary",
  re_export_cycles: "dependency_cycle_boundary",
  package_cycles: "dependency_cycle_boundary",
  boundary_violations: "architecture",
  boundary_coverage_violations: "architecture",
  boundary_call_violations: "architecture",
  policy_violations: "architecture",
  private_type_leaks: "unused_file_export_dep",
  type_only_dependencies: "unused_file_export_dep",
  test_only_dependencies: "unused_file_export_dep",
  dev_dependencies_in_production: "unused_file_export_dep",
};

/** fallow dead-code emits one top-level array per issue class. */
function extractFallowDeadCode(raw: string): Extracted[] {
  const root = parseJson(raw, "fallow");
  const out: Extracted[] = [];
  for (const [key, category] of Object.entries(FALLOW_CATEGORY)) {
    asArray(root[key]).forEach((entry, i) => {
      // Dependency findings name a package, not a file. Anchor them to the importing
      // file so the finding is adjudicable at a path:line, and keep the package in the
      // message.
      const path =
        asString(entry.path) ||
        asString(asArray(entry.imported_from)[0]?.path) ||
        asString(entry.package_name);
      out.push({
        rule_id: key,
        category,
        severity: "warning",
        path,
        line: asNumber(entry.line) ?? asNumber(asArray(entry.imported_from)[0]?.line),
        message:
          asString(entry.export_name) ||
          asString(entry.package_name) ||
          asString(entry.message) ||
          key.replaceAll("_", " "),
        json_pointer: `/${key}/${i}`,
      });
    });
  }
  return out;
}

function extractFallowDupes(raw: string): Extracted[] {
  const root = parseJson(raw, "fallow");
  return asArray(root.clone_groups).map((group, i) => {
    const instances = asArray(group.instances);
    const first = (instances[0] ?? {}) as Json;
    return {
      rule_id: "code-duplication",
      category: "duplication",
      severity: "info",
      path: asString(first.file),
      line: asNumber(first.start_line),
      message: `duplicate block: ${instances.length} instances, ${String(group.line_count ?? "?")} lines, fingerprint ${asString(group.fingerprint)}`,
      json_pointer: `/clone_groups/${i}`,
    };
  });
}

function extractFallowHealth(raw: string): Extracted[] {
  const root = parseJson(raw, "fallow");
  return asArray(root.findings).map((finding, i) => ({
    rule_id: asString(finding.exceeded) || "complexity",
    category: "complexity",
    severity: sev(finding.effective_severity ?? finding.severity),
    path: asString(finding.path),
    line: asNumber(finding.line),
    message: `${asString(finding.name)}: cyclomatic ${String(finding.cyclomatic ?? "?")}, cognitive ${String(finding.cognitive ?? "?")}, lines ${String(finding.line_count ?? "?")}`,
    json_pointer: `/findings/${i}`,
  }));
}

function extractJscpd(raw: string): Extracted[] {
  const root = parseJson(raw, "jscpd");
  return asArray(root.duplicates).map((clone, i) => {
    const first = (clone.firstFile ?? {}) as Json;
    const second = (clone.secondFile ?? {}) as Json;
    return {
      rule_id: asString(clone.kind) || "clone",
      category: "duplication",
      severity: "info",
      path: asString(first.name),
      line: asNumber(first.start),
      message: `clone of ${String(clone.lines ?? "?")} lines in ${asString(second.name)}:${String(second.start ?? "?")} (${String(clone.tokens ?? "?")} tokens)`,
      json_pointer: `/duplicates/${i}`,
    };
  });
}

const AISLOP_CATEGORY: Record<string, Finding["category"]> = {
  "ai-slop": "ai_pattern",
  lint: "lint_correctness",
  format: "lint_style",
  security: "lint_correctness",
};

/** aislop's `code-quality` engine reports two unrelated things under one name: size
 * counts (`complexity/*`) and clone blocks. Categorising by engine filed both under
 * `unused_file_export_dep`, which made the repo look complexity-free, so the rule
 * decides. */
function aislopCategory(engine: string, rule: string): Finding["category"] {
  if (rule.startsWith("complexity/")) return "complexity";
  if (rule === "code-quality/duplicate-block") return "duplication";
  return AISLOP_CATEGORY[engine] ?? "other";
}

function extractAislop(raw: string): Extracted[] {
  const root = parseJson(raw, "aislop");
  return asArray(root.diagnostics).map((d, i) => ({
    rule_id: asString(d.rule) || null,
    category: aislopCategory(asString(d.engine), asString(d.rule)),
    severity: sev(d.severity),
    path: asString(d.filePath),
    line: asNumber(d.line),
    message: asString(d.message),
    json_pointer: `/diagnostics/${i}`,
  }));
}

/** tsc is the one text reporter: `path(line,col): error TS1234: message`. */
const TSC_LINE =
  /^(?<path>[^(]+)\((?<line>\d+),(?<column>\d+)\):\s+(?<severity>error|warning)\s+(?<code>TS\d+):\s+(?<message>.*)$/;

function extractTsc(raw: string): Extracted[] {
  const out: Extracted[] = [];
  raw.split("\n").forEach((line, i) => {
    const match = TSC_LINE.exec(line);
    if (match?.groups === undefined) return;
    out.push({
      rule_id: match.groups.code ?? null,
      category: "type_error",
      severity: sev(match.groups.severity),
      path: match.groups.path ?? "",
      line: Number(match.groups.line),
      message: match.groups.message ?? "",
      json_pointer: `/text/${i}`,
    });
  });
  return out;
}

/** `index` selects which invocation of the tool produced this output. */
const EXTRACTORS: Record<string, (raw: string, index: number) => Extracted[]> = {
  biome: (raw) => extractBiome(raw),
  knip: (raw) => extractKnip(raw),
  oxlint: (raw) => extractOxlint(raw),
  jscpd: (raw) => extractJscpd(raw),
  aislop: (raw) => extractAislop(raw),
  tsc: (raw) => extractTsc(raw),
  fallow: (raw, index) =>
    index === 0
      ? extractFallowDeadCode(raw)
      : index === 1
        ? extractFallowDupes(raw)
        : extractFallowHealth(raw),
};

export function extract(toolId: string, raw: string, invocationIndex = 0): Extracted[] {
  const fn = EXTRACTORS[toolId];
  if (fn === undefined) throw new Error(`no extractor for tool "${toolId}"`);
  return fn(raw, invocationIndex).filter((e) => e.path !== "");
}

/** Stable 8-hex digest of a message, so ids survive analyzer reordering. FNV-1a. */
function digest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * What a tool says it scanned, when its own output says so. Null means the tool
 * reports findings but not coverage — which is why a zero-finding directory cannot
 * be read as "clean" without this.
 */
export function reportedFileCount(
  tool: string,
  raw: string,
): { reported: number | null; source: string | null } {
  const none = { reported: null, source: null };
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return none;
    root = parsed as Record<string, unknown>;
  } catch {
    return none;
  }
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (tool === "oxlint") return { reported: num(root.number_of_files), source: "number_of_files" };
  if (tool === "aislop") {
    const coverage = root.coverage as Record<string, unknown> | undefined;
    return { reported: num(coverage?.supportedFiles), source: "coverage.supportedFiles" };
  }
  if (tool === "jscpd") {
    const stats = root.statistics as { total?: Record<string, unknown> } | undefined;
    return { reported: num(stats?.total?.sources), source: "statistics.total.sources" };
  }
  if (tool === "biome") {
    const summary = root.summary as Record<string, unknown> | undefined;
    const changed = num(summary?.changed);
    const unchanged = num(summary?.unchanged);
    if (changed === null && unchanged === null) return none;
    return { reported: (changed ?? 0) + (unchanged ?? 0), source: "summary.changed+unchanged" };
  }
  return none;
}

/** Build findings, attributing each to the tool run that produced it. */
export function toFindings(
  tool: ToolVersion,
  extracted: Extracted[],
  rawOutput: string,
  invocationIndex: number,
): Finding[] {
  // A rule can fire twice on one line with identical text (two non-null assertions, two
  // exports). The content-derived id cannot tell those apart, so repeats get an ordinal
  // suffix; a single occurrence keeps the bare id, which is what every frozen artifact
  // and cross-run join expects.
  const baseIds = extracted.map(
    (e) => `${tool.id}:${e.rule_id ?? "unknown"}:${e.path}:${e.line ?? 0}:${digest(e.message)}`,
  );
  const occurrences = new Map<string, number>();
  const ordinals = baseIds.map((base) => {
    const n = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, n);
    return n;
  });
  return extracted.map((e, i) => {
    const key = dedupeKey(e.path, e.line, e.category);
    const ordinal = ordinals[i] ?? 1;
    const id = ordinal === 1 ? (baseIds[i] ?? "") : `${baseIds[i] ?? ""}#${String(ordinal)}`;
    return {
      // The id must not depend on a tool's emission order: oxlint is multi-threaded and
      // reorders diagnostics between runs, which would otherwise change the sample.
      id,
      tools: [tool.id],
      primary_tool: tool.id,
      rule_id: e.rule_id,
      category: e.category,
      severity: e.severity,
      path: e.path,
      line: e.line,
      message: e.message,
      dedupe_key: key,
      verification: {
        validity: "unreviewed",
        actionability: "not_applicable",
        consequence: "not_applicable",
        by: null,
        method: null,
        evidence_ref: null,
        checked_at: null,
      },
      provenance: {
        tool_id: tool.id,
        tool_version: tool.version,
        raw_output: rawOutput,
        json_pointer: e.json_pointer,
        invocation_index: invocationIndex,
      },
    } satisfies Finding;
  });
}

/** Merge findings that share a dedupe key, keeping every contributing tool. */
export function mergeDuplicates(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byKey.get(finding.dedupe_key);
    if (existing === undefined) {
      byKey.set(finding.dedupe_key, finding);
      out.push(finding);
      continue;
    }
    // Same tool, same bucket: distinct instances (two clone pairs, two exports).
    if (existing.primary_tool === finding.primary_tool) {
      out.push(finding);
      continue;
    }
    // Different tool, same location: one finding, both tools credited.
    if (!existing.tools.includes(finding.primary_tool)) existing.tools.push(finding.primary_tool);
  }
  return out;
}
