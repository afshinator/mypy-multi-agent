#!/usr/bin/env bun
/**
 * Emit and verify the identity manifest for a provisioned analyzer prefix.
 *
 * Identity is a property of the executed code, not of a name: `node_modules/.bin/<tool>`
 * is a JS shim for biome/jscpd/oxlint, so the shim's hash alone proves nothing. Each tool
 * therefore records the invoked entry, its realpath, that file's sha256, and — where the
 * shim spawns one — the platform binary's path and hash.
 *
 * Usage:  bun manifest.ts <prefix>            # write <prefix>/toolchain.json
 *         bun manifest.ts <prefix> --verify   # re-check an existing manifest; exit 3 on mismatch
 * Exit:   0 ok, 3 identity/provisioning broken (nothing measured).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type Invocation = {
  argv: string[];
  cwd: "scan_root";
  timeout_ms: number;
  /** Exit codes that mean the tool ran and reported. Anything else is a failure. */
  expected_exit_codes: number[];
};

type ToolSpec = {
  id: string;
  cohort: "existing" | "new";
  pkg: string;
  version: string;
  binName: string;
  versionProbe: { argv: string[]; expect_regex: string };
  /** Relative glob for the platform executable the shim spawns. */
  platformBinary?: string[];
  /** `true` when the tool writes into the scanned tree even in analysis mode. */
  writesToTree: boolean;
  telemetryEnv: Record<string, string>;
  invocations: Invocation[];
};

const TOOLS: ToolSpec[] = [
  {
    id: "biome",
    cohort: "existing",
    pkg: "@biomejs/biome",
    version: "2.6.2",
    binName: "biome",
    versionProbe: { argv: ["--version"], expect_regex: "^Version: 2\\.6\\.2$" },
    platformBinary: ["@biomejs/cli-*/biome"],
    writesToTree: false,
    telemetryEnv: { NO_COLOR: "1", CI: "1" },
    invocations: [
      {
        argv: ["check", ".", "--reporter=json"],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0, 1],
      },
    ],
  },
  {
    id: "fallow",
    cohort: "existing",
    pkg: "fallow",
    version: "3.31.0",
    binName: "fallow",
    versionProbe: { argv: ["--version"], expect_regex: "^fallow 3\\.31\\.0$" },
    writesToTree: true,
    telemetryEnv: { NO_COLOR: "1", CI: "1" },
    invocations: [
      {
        argv: ["dead-code", "--format", "json", "--quiet"],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0, 1],
      },
      {
        argv: ["dupes", "--format", "json", "--quiet"],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0, 1],
      },
      {
        argv: ["health", "--format", "json", "--quiet"],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0, 1],
      },
    ],
  },
  {
    id: "tsc",
    cohort: "existing",
    pkg: "typescript",
    version: "5.9.3",
    binName: "tsc",
    versionProbe: { argv: ["--version"], expect_regex: "^Version 5\\.9\\.3$" },
    writesToTree: false,
    telemetryEnv: { NO_COLOR: "1", CI: "1" },
    invocations: [
      { argv: ["--noEmit"], cwd: "scan_root", timeout_ms: 300_000, expected_exit_codes: [0, 2] },
    ],
  },
  {
    id: "knip",
    cohort: "new",
    pkg: "knip",
    version: "6.43.0",
    binName: "knip",
    versionProbe: { argv: ["--version"], expect_regex: "^6\\.43\\.0$" },
    writesToTree: false,
    telemetryEnv: { NO_COLOR: "1", CI: "1", DO_NOT_TRACK: "1" },
    invocations: [
      {
        argv: ["--reporter", "json"],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0, 1],
      },
    ],
  },
  {
    id: "oxlint",
    cohort: "new",
    pkg: "oxlint",
    version: "1.90.0",
    binName: "oxlint",
    versionProbe: { argv: ["--version"], expect_regex: "^Version: 1\\.90\\.0$" },
    platformBinary: ["@oxlint/binding-*/oxlint.*.node"],
    writesToTree: false,
    telemetryEnv: { NO_COLOR: "1", CI: "1" },
    invocations: [
      {
        argv: ["-f", "json", "."],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0],
      },
    ],
  },
  {
    id: "jscpd",
    cohort: "new",
    pkg: "jscpd",
    version: "5.4.2",
    binName: "jscpd",
    versionProbe: { argv: ["--version"], expect_regex: "^jscpd 5\\.4\\.2$" },
    platformBinary: ["jscpd-*/bin/jscpd"],
    // Writes ./report/ into cwd unless -o points outside the scanned tree.
    writesToTree: true,
    telemetryEnv: { NO_COLOR: "1", CI: "1", JSCPD_NO_TIPS: "1" },
    invocations: [
      {
        argv: [
          "-r",
          "json",
          "-o",
          "{out}/jscpd",
          "--min-tokens",
          "50",
          "--min-lines",
          "5",
          "--no-tips",
          ".",
        ],
        cwd: "scan_root",
        timeout_ms: 300_000,
        expected_exit_codes: [0],
      },
    ],
  },
  {
    id: "aislop",
    cohort: "new",
    pkg: "aislop",
    version: "0.18.1",
    binName: "aislop",
    versionProbe: { argv: ["--version"], expect_regex: "^0\\.18\\.1$" },
    // Writes .ruff_cache/ into the scanned tree and ~/.aislop/install_id outside it.
    writesToTree: true,
    telemetryEnv: {
      AISLOP_NO_TELEMETRY: "1",
      AISLOP_NO_UPDATE_NOTIFIER: "1",
      AISLOP_NO_HISTORY: "1",
      NO_COLOR: "1",
      CI: "1",
    },
    invocations: [
      {
        argv: ["scan", ".", "--json"],
        cwd: "scan_root",
        timeout_ms: 600_000,
        expected_exit_codes: [0, 1],
      },
    ],
  },
];

/** Tools the pilot must record but cannot run as analyzers today. */
const DEFERRED = [
  {
    id: "dependency-cruiser",
    status: "blocked",
    version_researched: "18.7.0",
    reason:
      "Exits 1 with \"Can't open a config file (.dependency-cruiser.(c|m)js)\" without a ruleset; --no-config produced 1299 modules and 20 'circular' findings all inside node_modules. Needs an authored ruleset before it measures anything.",
  },
  {
    id: "dmmulroy/anti-slop",
    status: "unsupported",
    version_researched: "0.1.2 (private, vendored)",
    reason:
      "No npm package (E404). Source-only oxlint JS plugin meant to be vendored; pins oxlint 1.78.0 against the 1.90.0 host; its no-reflect-apply conflicts with oxlint unicorn/prefer-reflect-apply.",
  },
  {
    id: "typescript-eslint",
    status: "deferred",
    version_researched: "n/a",
    reason:
      "Requires eslint; oxlint --type-aware/--type-check covers the same type-aware axis without a second linter.",
  },
];

const PINS: Record<string, string> = Object.fromEntries(TOOLS.map((t) => [t.pkg, t.version]));

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Expand a `dir/<glob>/file` pattern one path segment at a time. No glob dependency. */
function expand(root: string, pattern: string): string[] {
  let candidates = [""];
  for (const segment of pattern.split("/")) {
    const next: string[] = [];
    const anchored = new RegExp(
      `^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    for (const candidate of candidates) {
      if (!segment.includes("*")) {
        next.push(join(candidate, segment));
        continue;
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(join(root, candidate));
      } catch {
        continue;
      }
      for (const entry of entries) if (anchored.test(entry)) next.push(join(candidate, entry));
    }
    candidates = next;
  }
  return candidates
    .map((candidate) => join(root, candidate))
    .filter((full) => existsSync(full) && statSync(full).isFile());
}

/** Resolve the platform executable a shim spawns, e.g. the biome binary under @biomejs/cli-<platform>. */
function findPlatformBinary(
  prefix: string,
  patterns: string[],
): { path: string; sha256: string } | undefined {
  const root = join(prefix, "node_modules");
  for (const pattern of patterns) {
    const [match] = expand(root, pattern);
    if (match !== undefined) return { path: match, sha256: sha256(match) };
  }
  return undefined;
}

function probe(bin: string, argv: string[]): { ok: boolean; output: string } {
  const r = spawnSync(bin, argv, { encoding: "utf8", timeout: 30_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, output };
}

function build(prefix: string) {
  const errors: string[] = [];
  const tools: Record<string, unknown>[] = [];

  for (const spec of TOOLS) {
    const bin = join(prefix, "node_modules", ".bin", spec.binName);
    if (!existsSync(bin)) {
      errors.push(`${spec.id}: missing binary ${bin}`);
      continue;
    }
    const real = realpathSync(bin);
    const version = probe(bin, spec.versionProbe.argv);
    const firstLine = version.output.split("\n")[0] ?? "";
    const matches = new RegExp(spec.versionProbe.expect_regex, "m").test(firstLine);
    if (!version.ok || !matches) {
      errors.push(
        `${spec.id}: version probe failed — expected /${spec.versionProbe.expect_regex}/ got "${firstLine}"`,
      );
    }
    const platform =
      spec.platformBinary === undefined
        ? undefined
        : findPlatformBinary(prefix, spec.platformBinary);
    if (spec.platformBinary !== undefined && platform === undefined) {
      errors.push(
        `${spec.id}: expected a platform binary matching ${spec.platformBinary.join(", ")} — none found`,
      );
    }
    tools.push({
      id: spec.id,
      cohort: spec.cohort,
      package: spec.pkg,
      version: spec.version,
      bin: `node_modules/.bin/${spec.binName}`,
      bin_realpath: real,
      bin_sha256: sha256(real),
      ...(platform === undefined ? {} : { platform_binary: platform }),
      version_probe: {
        argv: spec.versionProbe.argv,
        expect_regex: spec.versionProbe.expect_regex,
        observed: firstLine,
      },
      invocations: spec.invocations,
      writes_to_tree: spec.writesToTree,
      telemetry_env: spec.telemetryEnv,
    });
  }

  /** Registry-side install-hook audit. Provisioning has network; --verify does not. */
  function auditInstallScripts(pins: Record<string, string>): Record<string, string[]> {
    const audit: Record<string, string[]> = {};
    for (const [pkg, version] of Object.entries(pins)) {
      const r = spawnSync("npm", ["view", `${pkg}@${version}`, "scripts", "--json"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (r.status !== 0) {
        audit[pkg] = ["UNCHECKED"];
        continue;
      }
      try {
        const scripts = JSON.parse(r.stdout.trim() || "{}") as Record<string, string>;
        audit[pkg] = Object.keys(scripts).filter((k) =>
          ["preinstall", "install", "postinstall", "prepare", "prepack"].includes(k),
        );
      } catch {
        audit[pkg] = ["UNCHECKED"];
      }
    }
    return audit;
  }

  const manifest = {
    schema_version: "1.0",
    prefix,
    generated_at: new Date().toISOString(),
    host: {
      os: process.platform,
      arch: process.arch,
      node: process.versions.node,
      bun: process.versions.bun ?? "unknown",
    },
    install: {
      method: "bun install --frozen-lockfile --ignore-scripts",
      pin_files: ["package.json", "bun.lock"],
      lockfile_sha256: sha256(join(prefix, "bun.lock")),
      ignore_scripts_at_install: true,
      script_audit: {
        method: "npm view <pkg>@<version> scripts --json",
        lifecycle_keys: ["preinstall", "install", "postinstall", "prepare", "prepack"],
        hooks: auditInstallScripts(PINS),
        note: "prepare/prepack are declared by dev tooling and are not run for registry tarballs; --ignore-scripts makes this moot for the install itself.",
      },
    },
    tools,
    deferred: DEFERRED,
    identity_policy: {
      require_realpath_match: true,
      require_sha256_match: true,
      on_mismatch: "abort_run_exit_3",
    },
  };
  return { manifest, errors };
}

const prefixArg = process.argv[2];
if (prefixArg === undefined) {
  console.error("usage: bun manifest.ts <prefix> [--verify]");
  process.exit(2);
}

if (process.argv.includes("--verify")) {
  const manifestPath = join(prefixArg, "toolchain.json");
  if (!existsSync(manifestPath)) {
    console.error(`identity check failed: no manifest at ${manifestPath} — provision first`);
    process.exit(3);
  }
  const recorded = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    tools: Record<string, unknown>[];
  };
  const problems: string[] = [];
  for (const tool of recorded.tools) {
    const bin = join(prefixArg, String(tool.bin));
    if (!existsSync(bin)) {
      problems.push(`${String(tool.id)}: missing ${bin}`);
      continue;
    }
    const real = realpathSync(bin);
    if (real !== tool.bin_realpath) problems.push(`${String(tool.id)}: realpath changed (${real})`);
    if (sha256(real) !== tool.bin_sha256)
      problems.push(`${String(tool.id)}: entry sha256 mismatch`);
    const platform = tool.platform_binary as { path: string; sha256: string } | undefined;
    if (platform !== undefined) {
      if (!existsSync(platform.path))
        problems.push(`${String(tool.id)}: missing platform binary ${platform.path}`);
      else if (sha256(platform.path) !== platform.sha256)
        problems.push(`${String(tool.id)}: platform binary sha256 mismatch`);
    }
  }
  if (problems.length > 0) {
    console.error(`identity check failed (${problems.length}):\n  ${problems.join("\n  ")}`);
    process.exit(3);
  }
  console.log(`identity ok: ${recorded.tools.length} tools verified in ${prefixArg}`);
  process.exit(0);
}

if (!existsSync(join(prefixArg, "bun.lock"))) {
  console.error(`no bun.lock in ${prefixArg} — run provision.sh`);
  process.exit(3);
}

const { manifest, errors } = build(prefixArg);
writeFileSync(join(prefixArg, "toolchain.json"), `${JSON.stringify(manifest, null, 2)}\n`);

if (errors.length > 0) {
  console.error(`provisioning broken (${errors.length}):\n  ${errors.join("\n  ")}`);
  process.exit(3);
}
console.log(
  `toolchain.json written: ${manifest.tools.length} tools, ${manifest.deferred.length} deferred`,
);
for (const t of manifest.tools) {
  console.log(
    `  ${String(t.id).padEnd(8)} ${String(t.version).padEnd(8)} ${String(t.bin_sha256).slice(0, 12)}…`,
  );
}
