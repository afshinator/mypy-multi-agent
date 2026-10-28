/**
 * Installed-version resolution for the packages an analyzer says are vulnerable.
 *
 * `aislop security/vulnerable-dependency` names a package but not a version, so the
 * pilot's "verified" verdicts on those two findings rested on a model reading
 * `bun.lock` by hand and quoting line numbers in prose. This resolves the version from
 * the lockfile that is actually present, and records which file it came from.
 *
 * Formats are implemented only where a real lockfile was available to check the shape
 * against. pnpm and yarn return null rather than a guessed parse.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedDependency {
  package: string;
  version: string;
  source: string;
}

/** bun.lock is JSONC: it carries trailing commas, and real-world copies carry comments. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/** `"pkg@1.2.3"` -> `1.2.3`, including scoped names whose version follows the last `@`. */
const versionFromSpec = (spec: string): string | null => {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(at + 1) : null;
};

/** Strip one layer of surrounding single or double quotes. */
const unquote = (s: string): string => {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
  ) {
    return t.slice(1, -1);
  }
  return t;
};

/** `"@scope/pkg@1.2.3"` or `"pkg@^1.0.0"` -> `{name, version}`, split at the LAST `@`. */
const splitNameVersion = (spec: string): { name: string; version: string } | null => {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : null;
};

/** pnpm v9 importer versions carry parenthesized peer suffixes: `1.0.2(...)` -> `1.0.2`. */
const stripPeerSuffix = (v: string): string => {
  const idx = v.indexOf("(");
  return idx === -1 ? v : v.slice(0, idx);
};

/** Numeric compare of `x.y.z`; prerelease/build suffixes are ignored. */
const compareVersions = (a: string, b: string): number => {
  const parts = (v: string) =>
    (v.split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const an = parts(a);
  const bn = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

function fromBun(root: string, pkg: string): ResolvedDependency | null {
  const path = existsSync(join(root, "bun.lock")) ? "bun.lock" : null;
  if (path === null) return null;
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(join(root, path), "utf8"))) as {
      packages?: Record<string, unknown>;
    };
    const entry = parsed.packages?.[pkg];
    const spec = Array.isArray(entry) ? entry[0] : undefined;
    if (typeof spec !== "string") return null;
    const version = versionFromSpec(spec);
    return version === null ? null : { package: pkg, version, source: path };
  } catch {
    return null;
  }
}

function fromNpm(root: string, pkg: string): ResolvedDependency | null {
  if (!existsSync(join(root, "package-lock.json"))) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      lockfileVersion?: number;
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    const flat = parsed.packages?.[`node_modules/${pkg}`];
    if (typeof flat?.version === "string") {
      return { package: pkg, version: flat.version, source: "package-lock.json" };
    }
    // v1 has no `packages` map; v2/v3 keep a top-level `dependencies` fallback for
    // the hoisted case. Prefer a non-nested path when a package is duplicated.
    const nested = Object.entries(parsed.packages ?? {}).filter(
      ([key]) => key.endsWith(`/node_modules/${pkg}`) || key === `node_modules/${pkg}`,
    );
    const shallow = nested.find(
      ([key]) => !key.slice(0, -`node_modules/${pkg}`.length).includes("node_modules"),
    );
    const pick = shallow ?? nested[0];
    if (typeof pick?.[1]?.version === "string") {
      return { package: pkg, version: pick[1].version, source: "package-lock.json" };
    }
    const legacy = parsed.dependencies?.[pkg];
    if (typeof legacy?.version === "string") {
      return { package: pkg, version: legacy.version, source: "package-lock.json" };
    }
    return null;
  } catch {
    return null;
  }
}

/** pnpm v9 lockfile: `importers` declares direct deps, `packages` is the hoisted store. */
function parsePnpm(text: string): {
  lockfileVersion: string;
  importers: Map<string, string>;
  store: Map<string, string[]>;
} {
  const importers = new Map<string, string>();
  const store = new Map<string, string[]>();
  let lockfileVersion = "";
  let section = "";
  let depType: string | null = null;
  let current: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (indent === 0) {
      const colon = content.indexOf(":");
      const key = colon === -1 ? content : content.slice(0, colon);
      if (key === "importers" || key === "packages" || key === "snapshots") {
        section = key;
      } else {
        section = "";
        if (key === "lockfileVersion") {
          lockfileVersion = unquote(content.slice(colon + 1).trim());
        }
      }
      depType = null;
      current = null;
      continue;
    }

    if (section === "importers") {
      if (indent === 2) {
        depType = null;
        current = null;
      } else if (indent === 4) {
        const key = content.replace(/:$/, "");
        depType = ["dependencies", "devDependencies", "optionalDependencies"].includes(key)
          ? key
          : null;
        current = null;
      } else if (indent === 6 && depType) {
        current = unquote(content.replace(/:$/, ""));
      } else if (indent === 8 && current) {
        const key = content.slice(0, content.indexOf(":"));
        if (key === "version") {
          importers.set(
            current,
            stripPeerSuffix(unquote(content.slice(content.indexOf(":") + 1).trim())),
          );
        }
      }
    } else if (section === "packages" && indent === 2) {
      const nv = splitNameVersion(unquote(content.replace(/:$/, "")));
      if (nv) {
        const versions = store.get(nv.name) ?? [];
        versions.push(nv.version);
        store.set(nv.name, versions);
      }
    }
  }
  return { lockfileVersion, importers, store };
}

function fromPnpm(root: string, pkg: string): ResolvedDependency | null {
  if (!existsSync(join(root, "pnpm-lock.yaml"))) return null;
  try {
    const { lockfileVersion, importers, store } = parsePnpm(
      readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    );
    if (!lockfileVersion.startsWith("9")) return null; // v6 uses a different grammar; out of scope
    const importer = importers.get(pkg);
    if (importer !== undefined)
      return { package: pkg, version: importer, source: "pnpm-lock.yaml" };
    const versions = store.get(pkg);
    if (!versions || versions.length === 0) return null;
    // A transitive-only package can sit at several store versions; pnpm hoists the highest.
    const best = versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
    return { package: pkg, version: best, source: "pnpm-lock.yaml" };
  } catch {
    return null;
  }
}

function fromYarn(root: string, pkg: string): ResolvedDependency | null {
  if (!existsSync(join(root, "yarn.lock"))) return null;
  try {
    const versions: string[] = [];
    let block: string | null = null;
    for (const raw of readFileSync(join(root, "yarn.lock"), "utf8").split("\n")) {
      const line = raw.trimEnd();
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (line[0] !== " " && line[0] !== "\t") {
        // Block header: `"@scope/pkg@^1":` or `pkg@^1, pkg@^2:` — name is in the first spec.
        const first = unquote((trimmed.replace(/:$/, "").split(",")[0] ?? "").trim());
        block = splitNameVersion(first)?.name ?? null;
      } else if (block !== null && trimmed.startsWith("version ")) {
        if (block === pkg) versions.push(unquote(trimmed.slice("version ".length).trim()));
        block = null;
      }
    }
    if (versions.length === 0) return null;
    // Several ranges can resolve to several versions; the hoisted one is the highest.
    const best = versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
    return { package: pkg, version: best, source: "yarn.lock" };
  } catch {
    return null;
  }
}

/**
 * The version actually installed for `pkg`, or null. Resolution is not verification:
 * a resolved version still has to be checked against an advisory database.
 */
export function resolveInstalled(root: string, pkg: string): ResolvedDependency | null {
  return fromBun(root, pkg) ?? fromNpm(root, pkg) ?? fromPnpm(root, pkg) ?? fromYarn(root, pkg);
}

/** `undici (high) — ...` -> `undici`; null when the message does not name a package. */
export function packageFromAdvisory(message: string): string | null {
  const match = /^(@?[A-Za-z0-9._/-]+)\s*\(/.exec(message.trim());
  return match?.[1] ?? null;
}
