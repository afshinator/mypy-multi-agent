#!/usr/bin/env bun
/**
 * Deterministic collector for a read-only anti-slop audit.
 *
 * Runs the pinned analyzers recorded in the toolchain manifest, preserves every raw
 * artifact, normalizes findings, proves what the run wrote, and picks the
 * verification sample BEFORE any model sees tool output.
 *
 *   bun scripts/antislop/collect.ts --root <scan-root> --out <audit-out> [--seed N]
 *
 * Audit agents never install or update anything; this script only executes absolute
 * paths recorded in the manifest and refuses to start when identity does not match.
 *
 * Exit: 0 at least one tool executed, 3 provisioning/identity broken (nothing
 * measured), 4 no tool executed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectEnvironment } from "./environment";
import { packageFromAdvisory, resolveInstalled } from "./lockfile";
import { extract, mergeDuplicates, reportedFileCount, toFindings } from "./normalize";
import { pickSample, type Stratum } from "./sample";
import type { Audit, Finding, ToolRun } from "./schema";

type ManifestTool = {
  id: string;
  cohort: "existing" | "new";
  version: string;
  bin: string;
  invocations: {
    argv: string[];
    cwd: string;
    timeout_ms: number;
    expected_nonzero_exit: boolean;
  }[];
  output_format?: "json" | "text";
  writes_to_tree: boolean;
  telemetry_env: Record<string, string>;
};

type Manifest = {
  prefix: string;
  install: { lockfile_sha256: string };
  tools: ManifestTool[];
  deferred: { id: string; status: string; reason: string }[];
};

/**
 * Writes a run produces inside the scanned tree, declared up front so they are
 * evidence rather than anomalies: analyzer caches, and the harness's own run
 * artifacts when the scanned repo is the repo running the audit.
 */
const DECLARED_DELTAS: { label: string; owner: string; matches: (p: string) => boolean }[] = [
  {
    label: ".fallow/",
    owner: "fallow cache+cache graph",
    matches: (p) => p.startsWith(".fallow/"),
  },
  {
    label: ".ruff_cache/",
    owner: "aislop -> ruff cache",
    matches: (p) => p.startsWith(".ruff_cache/"),
  },
  {
    label: "**/run-details/",
    owner: "multi-agent run artifacts (conversation, spans, tool-calls)",
    matches: (p) => p.startsWith("run-details/") || p.includes("/run-details/"),
  },
];

/** Reporters that emit text instead of JSON. */
const TEXT_TOOLS = new Set(["tsc"]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  // Generated or vendored, never source: a Python venv would otherwise inflate the
  // language surface by an order of magnitude and a .next build can hold thousands of files.
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".svelte-kit",
]);
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const isDeclaredPath = (p: string): boolean => DECLARED_DELTAS.some((d) => d.matches(p));

const sha256 = (buffer: Buffer | string): string =>
  createHash("sha256").update(buffer).digest("hex");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  return fallback;
}

function walk(root: string, skip: Set<string>, excludeRel?: string): Map<string, string> {
  const manifest = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (excludeRel !== undefined && (rel === excludeRel || rel.startsWith(`${excludeRel}/`)))
        continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      manifest.set(relative(root, full), sha256(readFileSync(full)));
    }
  };
  visit(root);
  return manifest;
}

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
};

/** Spawn one analyzer with a hard timeout. The shell gate is never involved. */
function runOnce(
  bin: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(bin, argv, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.toString("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = cap(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        elapsedMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

function writeRaw(outDir: string, name: string, body: string): string {
  const rel = join("raw", name);
  const full = join(outDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return rel;
}

function renderMarkdown(audit: Audit): string {
  const lines: string[] = [
    `# Anti-slop audit: ${audit.run.id}`,
    "",
    `- scan root: \`${audit.run.scan_root}\``,
    `- commit: \`${audit.run.commit ?? "unknown"}\``,
    `- schema: ${audit.schema_version}`,
    "",
    "## Tools",
    "",
    "| tool | cohort | version | status | exit | findings | elapsed |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const tool of audit.tools) {
    lines.push(
      `| ${tool.id} | ${tool.cohort} | ${tool.version} | ${tool.status} | ${tool.exit_code ?? "–"} | ${tool.finding_count} | ${tool.elapsed_ms ?? "–"} ms |`,
    );
  }
  lines.push("", "## Deferred / not measured", "");
  for (const tool of audit.tools.filter((t) => t.reason !== null)) {
    lines.push(`- **${tool.id}** — ${tool.status}: ${String(tool.reason)}`);
  }
  const byCategory = new Map<string, number>();
  for (const finding of audit.findings)
    byCategory.set(finding.category, (byCategory.get(finding.category) ?? 0) + 1);
  lines.push("", "## Findings by category", "", "| category | count |", "|---|---|");
  for (const [category, count] of [...byCategory.entries()].sort())
    lines.push(`| ${category} | ${count} |`);
  lines.push(
    "",
    "## Writes",
    "",
    `tree_unchanged: **${String(audit.run.tree_unchanged)}**`,
    "",
    ...audit.declared_deltas.map(
      (d) => `- declared ${d.path} (${d.owner}) — observed: ${String(d.observed)}`,
    ),
    ...audit.undeclared_deltas.map((d) => `- UNDECLARED ${d}`),
    "",
    "## What this does not prove",
    "",
    "- No labelled defect set exists, so recall is unmeasured.",
    "- No analyzer score is a measure of code correctness.",
    "- Sampling is stratified and seeded; findings outside the sample stay `unreviewed`.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const scanRoot = resolve(arg("--root") ?? process.cwd());
  const outArg = arg("--out");
  if (outArg === undefined) {
    console.error("collect: --out <dir outside the scan root> is required");
    return 2;
  }
  const outDir = resolve(outArg);
  if (!isAbsolute(outDir)) {
    console.error("collect: --out must be an absolute path");
    return 2;
  }
  // Output normally lives outside the scanned tree. Inside it is allowed only under a
  // declared delta prefix (the task's own run-details), because writing anywhere else
  // would change the artifact being audited without saying so.
  const outRelRaw = relative(scanRoot, outDir);
  const outInside = outRelRaw !== "" && !outRelRaw.startsWith("..") && !isAbsolute(outRelRaw);
  if (outDir === scanRoot || (outInside && !isDeclaredPath(`${outRelRaw}/`))) {
    console.error(
      "collect: --out inside the scan root is only allowed under a declared delta prefix (run-details)",
    );
    return 2;
  }
  const prefix = resolve(arg("--prefix") ?? join(process.env.HOME ?? "~", ".audit/antislop"));
  const seed = Number(arg("--seed") ?? 20261027);
  const cap = Number(arg("--sample-cap") ?? 80);

  const manifestPath = join(prefix, "toolchain.json");
  if (!existsSync(manifestPath)) {
    console.error(`collect: no manifest at ${manifestPath} — run provision.sh first`);
    return 3;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  // Identity first: a wrong binary makes every downstream number a lie.
  const manifestScript = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "toolchain",
    "manifest.ts",
  );
  const verification = spawnSync("bun", [manifestScript, prefix, "--verify"], { encoding: "utf8" });
  mkdirSync(join(outDir, "logs"), { recursive: true });
  writeFileSync(
    join(outDir, "logs", "preflight.json"),
    `${JSON.stringify({ exit: verification.status, stdout: verification.stdout, stderr: verification.stderr }, null, 2)}\n`,
  );
  if (verification.status !== 0) {
    console.error(`collect: identity check failed — nothing measured\n${verification.stderr}`);
    return 3;
  }

  const startedAt = new Date().toISOString();
  const before = walk(scanRoot, SKIP_DIRS, outInside ? outRelRaw : undefined);
  const gitHead = spawnSync("git", ["-C", scanRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const gitStatus = spawnSync("git", ["-C", scanRoot, "status", "--porcelain"], {
    encoding: "utf8",
  });

  const tools: ToolRun[] = [];
  const findings: Finding[] = [];
  const limitations: string[] = [];

  for (const tool of manifest.tools) {
    const bin = join(prefix, tool.bin);
    const outputFormat = TEXT_TOOLS.has(tool.id) ? "text" : "json";
    let findingCount = 0;
    let elapsed = 0;
    let exitCode: number | null = null;
    let timedOut = false;
    let failure: string | null = null;
    let firstStdout: string | null = null;
    let scanned: { reported: number | null; source: string | null } = {
      reported: null,
      source: null,
    };
    let anyExecuted = false;

    for (const [index, invocation] of tool.invocations.entries()) {
      const argv = invocation.argv.map((a) => a.replaceAll("{out}", outDir));
      const label = tool.invocations.length === 1 ? tool.id : `${tool.id}-${index}`;
      if (!existsSync(bin)) {
        failure = `missing binary ${bin}`;
        break;
      }
      const result = await runOnce(bin, argv, scanRoot, invocation.timeout_ms, tool.telemetry_env);
      anyExecuted = true;
      elapsed += result.elapsedMs;
      exitCode = result.code;
      timedOut = timedOut || result.timedOut;

      const stdoutRel = writeRaw(outDir, `${label}.stdout`, result.stdout);
      writeRaw(outDir, `${label}.stderr`, result.stderr);
      if (firstStdout === null) firstStdout = stdoutRel;

      // jscpd's JSON reporter writes a file rather than stdout: lift it into raw/.
      // The report lands under whatever `-o` names, so read that argv value.
      let rawForParse = result.stdout;
      const outputFlag = argv.indexOf("-o") >= 0 ? argv.indexOf("-o") : argv.indexOf("--output");
      if (tool.id === "jscpd" && outputFlag >= 0) {
        const report = join(argv[outputFlag + 1] ?? "", "jscpd-report.json");
        if (existsSync(report)) rawForParse = readFileSync(report, "utf8");
      }
      const rawRef =
        rawForParse === result.stdout ? stdoutRel : writeRaw(outDir, "jscpd.json", rawForParse);

      const fromReport = reportedFileCount(tool.id, rawForParse);
      if (fromReport.reported !== null) scanned = fromReport;

      if (rawForParse.trim() === "") continue;
      try {
        const extracted = extract(tool.id, rawForParse, index);
        findingCount += extracted.length;
        findings.push(
          ...toFindings({ id: tool.id, version: tool.version }, extracted, rawRef, index),
        );
      } catch (error) {
        failure = (error as Error).message;
      }
      if (failure !== null) break;
    }

    const status: ToolRun["status"] = !anyExecuted
      ? (failure?.startsWith("missing binary") ?? false)
        ? "not_installed"
        : "failure"
      : timedOut
        ? "timeout"
        : failure !== null
          ? "failure"
          : findingCount > 0
            ? "success_with_findings"
            : "clean";

    tools.push({
      id: tool.id,
      cohort: tool.cohort,
      version: tool.version,
      status,
      exit_code: exitCode,
      expected_nonzero_exit: tool.invocations[0]?.expected_nonzero_exit ?? false,
      timed_out: timedOut,
      elapsed_ms: anyExecuted ? elapsed : null,
      argv: tool.invocations[0]?.argv ?? [],
      raw: {
        stdout: firstStdout,
        stderr: tool.invocations.length > 1 ? `${tool.id}-0.stderr` : null,
      },
      output_format: outputFormat,
      finding_count: findingCount,
      files_scanned: scanned,
      deterministic: true,
      writes_to_tree: tool.writes_to_tree,
      reason: failure ?? (timedOut ? "invocation timed out; see logs" : null),
    });
  }

  for (const deferred of manifest.deferred) {
    tools.push({
      id: deferred.id,
      cohort: "new",
      version: "—",
      status:
        deferred.status === "blocked"
          ? "blocked"
          : deferred.status === "unsupported"
            ? "unsupported"
            : "deferred",
      exit_code: null,
      expected_nonzero_exit: false,
      timed_out: false,
      elapsed_ms: null,
      argv: [],
      raw: { stdout: null, stderr: null },
      output_format: "json",
      finding_count: 0,
      files_scanned: { reported: null, source: null },
      deterministic: true,
      writes_to_tree: false,
      reason: deferred.reason,
    });
  }

  const merged = mergeDuplicates(findings);
  const after = walk(scanRoot, SKIP_DIRS, outInside ? outRelRaw : undefined);

  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const changed = [...before.keys()].filter((p) => after.has(p) && after.get(p) !== before.get(p));

  const declared = DECLARED_DELTAS.map((d) => ({
    path: d.label,
    owner: d.owner,
    observed: [...added, ...changed].some((p) => d.matches(p)),
  }));
  const isDeclared = isDeclaredPath;
  const undeclared = [...added, ...removed, ...changed].filter((p) => !isDeclared(p)).sort();

  const { strata, ids } = pickSample(merged, seed, cap);
  writeFileSync(
    join(outDir, "sample.json"),
    `${JSON.stringify({ seed, cap, method: "stratified_rule_family", finding_ids: ids, strata }, null, 2)}\n`,
  );

  if (undeclared.length > 0) {
    limitations.push(
      `undeclared tree changes detected (${undeclared.length}) — see undeclared_deltas`,
    );
  }
  limitations.push(
    "no labelled defect set exists, so recall is unmeasured",
    "no analyzer score is a measure of code correctness",
    "instruction-based reviews, when present, are a separate dataset from analyzer findings",
  );

  // A dependency advisory names a package, not a version. Resolve it from whichever
  // lockfile the repo has, so an adjudicator does not have to read the lockfile by hand.
  const resolved = merged.map((finding) => {
    if (finding.rule_id !== "security/vulnerable-dependency") return finding;
    const pkg = packageFromAdvisory(finding.message);
    return pkg === null
      ? finding
      : { ...finding, resolved_dependency: resolveInstalled(scanRoot, pkg) };
  });

  const audit: Audit = {
    schema_version: "0.4",
    run: {
      id: process.env.AUDIT_RUN_ID ?? `audit-${startedAt.replaceAll(/[:.]/g, "-")}`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      scan_root: scanRoot,
      output_root: outDir,
      commit: gitHead.status === 0 ? gitHead.stdout.trim() : null,
      git_status_clean_before: (gitStatus.stdout ?? "").trim() === "",
      // Declared caches are expected to be rewritten each run. "Unchanged" means no
      // pre-existing file outside a declared prefix was touched.
      tree_unchanged: [...changed, ...removed].filter((p) => !isDeclared(p)).length === 0,
      host: { os: process.platform, arch: process.arch, bun: process.versions.bun ?? "unknown" },
      toolchain_manifest_sha256: sha256(readFileSync(manifestPath)),
    },
    scope: {
      included: ["**/*"],
      excluded: [...SKIP_DIRS].map((d) => `${d}/**`),
      environment: detectEnvironment(scanRoot, {
        skipDirs: SKIP_DIRS,
        skipRelPaths: outInside ? new Set([outRelRaw]) : undefined,
      }),
    },
    declared_deltas: declared,
    undeclared_deltas: undeclared,
    tools,
    findings: resolved.sort((a, b) =>
      a.dedupe_key === b.dedupe_key
        ? a.id.localeCompare(b.id)
        : a.dedupe_key.localeCompare(b.dedupe_key),
    ),
    instruction_reviews: [],
    verification: {
      sampling: {
        method: "stratified",
        seed,
        frame_size: ids.length,
        strata: strata.map(({ key, frame, sampled }: Stratum) => ({ key, frame, sampled })),
      },
      counts: {
        // Every merged finding starts unadjudicated; verify.ts fills the dimensions when
        // verifier-verdicts.json is present. Counted over `merged`, not raw output: two
        // analyzers reporting the same defect collapse into one finding.
        unreviewed: merged.length,
        present: 0,
        absent: 0,
        duplicate: 0,
        undecidable: 0,
      },
      by_family: [],
      caveats: [
        "precision is measured only on the adjudicated sample, never on the population",
        "findings outside the sample remain unreviewed",
      ],
    },
    limitations,
  };

  writeFileSync(join(outDir, "audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
  writeFileSync(join(outDir, "audit.md"), renderMarkdown(audit));

  const executed = tools.filter(
    (t) => t.status === "clean" || t.status === "success_with_findings",
  );
  console.log(
    `collect: ${executed.length}/${tools.length} tools measured, ${merged.length} findings (${findings.length} raw), sample ${ids.length}`,
  );
  console.log(
    `collect: out=${outDir} tree_unchanged=${String(audit.run.tree_unchanged)} undeclared=${undeclared.length}`,
  );
  return executed.length > 0 ? 0 : 4;
}

const code = await main();
process.exit(code);
