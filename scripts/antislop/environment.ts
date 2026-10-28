/**
 * What the scanned repository is configured to be.
 *
 * The pilot measured tools without recording this, so two of its largest
 * false-positive families (knip `files`/`exports` 0/10, fallow `unused_files` 0/3)
 * are indistinguishable from "this repo declares no entry points". A second repo
 * cannot be compared against the first until the configuration is part of the
 * artifact.
 *
 * Everything here is derived from files on disk, after the same exclusions the
 * analyzers use, so a `.venv` shows up as an exclusion rather than as code.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { z } from "zod";

const LOCKFILES: { file: string; manager: string }[] = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
];

const LINTER_CONFIGS = [
  "biome.json",
  "biome.jsonc",
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.ts",
  ".eslintrc.json",
  ".eslintrc.js",
  ".stylelintrc.json",
  "ruff.toml",
  "pyproject.toml",
];

export const LANGUAGE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".kt",
  ".svelte",
  ".vue",
] as const;

export interface EnvOptions {
  /** Directory names the analyzers skip; the surface walk skips them too. */
  skipDirs: Set<string>;
  /** Extra exclusions that are not directory-name based (e.g. a task's own out dir). */
  skipRelPaths?: Set<string>;
}

export const EnvironmentSchema = z.strictObject({
  package_manager: z.string().nullable(),
  lockfiles: z.array(z.string()),
  workspaces: z.strictObject({ declared: z.boolean(), source: z.string().nullable() }),
  entry_declarations: z.strictObject({
    knip_config: z.string().nullable(),
    fallow_config: z.string().nullable(),
    package_bin: z.array(z.string()),
    tsconfig_include: z.array(z.string()),
    tsconfig_exclude: z.array(z.string()),
  }),
  linters_present: z.array(z.string()),
  /** Per-extension file and line counts, computed after `skipDirs`. */
  language_surface: z.array(
    z.strictObject({ ext: z.string(), files: z.number().int(), loc: z.number().int() }),
  ),
  /** Directories the walk skipped, as relative paths, so an exclusion is visible as one. */
  excluded_present: z.array(z.string()),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const stringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function packageManager(root: string): { manager: string | null; lockfiles: string[] } {
  const found = LOCKFILES.filter((l) => existsSync(join(root, l.file)));
  const order = ["pnpm", "yarn", "npm", "bun"];
  const manager = found
    .map((f) => f.manager)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return { manager: manager ?? null, lockfiles: found.map((f) => f.file) };
}

function workspaces(root: string, pkg: Record<string, unknown> | undefined) {
  if (existsSync(join(root, "pnpm-workspace.yaml")))
    return { declared: true, source: "pnpm-workspace.yaml" };
  if (Array.isArray(pkg?.workspaces) && pkg.workspaces.length > 0)
    return { declared: true, source: "package.json workspaces" };
  const nested = pkg?.workspaces as { packages?: unknown } | undefined;
  if (Array.isArray(nested?.packages) && nested.packages.length > 0)
    return { declared: true, source: "package.json workspaces.packages" };
  return { declared: false, source: null };
}

function languageSurface(
  root: string,
  opts: EnvOptions,
  skipped: Set<string>,
): Environment["language_surface"] {
  const counts = new Map<string, { files: number; loc: number }>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.skipDirs.has(entry.name) || opts.skipRelPaths?.has(relative(root, full))) {
          skipped.add(relative(root, full));
          continue;
        }
        walk(full);
        continue;
      }
      const ext = extname(entry.name);
      if (!(LANGUAGE_EXTENSIONS as readonly string[]).includes(ext)) continue;
      const text = readFileSync(full, "utf8");
      const row = counts.get(ext) ?? { files: 0, loc: 0 };
      row.files += 1;
      row.loc += text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      counts.set(ext, row);
    }
  };
  walk(root);
  return [...counts.entries()]
    .map(([ext, v]) => ({ ext, files: v.files, loc: v.loc }))
    .sort((a, b) => b.loc - a.loc || a.ext.localeCompare(b.ext));
}

/** Read the repo's configuration; nothing here executes a tool. */
export function detectEnvironment(root: string, opts: EnvOptions): Environment {
  const pkg = readJson(join(root, "package.json"));
  const tsconfig = readJson(join(root, "tsconfig.json"));
  const { manager, lockfiles } = packageManager(root);
  const knip = [".knip.json", "knip.json"].find((f) => existsSync(join(root, f))) ?? null;
  const fallow =
    [".fallowrc.json", ".fallowrc", "fallow.json"].find((f) => existsSync(join(root, f))) ?? null;
  const bin = pkg?.bin;
  const binNames =
    typeof bin === "string"
      ? [String(pkg?.name ?? "bin")]
      : Object.keys((bin as Record<string, unknown> | undefined) ?? {});
  const skipped = new Set<string>();
  const surface = languageSurface(root, opts, skipped);
  return EnvironmentSchema.parse({
    package_manager: manager,
    lockfiles,
    workspaces: workspaces(root, pkg),
    entry_declarations: {
      knip_config: knip,
      fallow_config: fallow,
      package_bin: binNames,
      tsconfig_include: stringArray(tsconfig?.include),
      tsconfig_exclude: stringArray(tsconfig?.exclude),
    },
    linters_present: LINTER_CONFIGS.filter((f) => existsSync(join(root, f))),
    language_surface: surface,
    excluded_present: [...skipped].sort(),
  });
}
