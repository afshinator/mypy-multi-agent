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

/**
 * The version actually installed for `pkg`, or null. Resolution is not verification:
 * a resolved version still has to be checked against an advisory database.
 */
export function resolveInstalled(root: string, pkg: string): ResolvedDependency | null {
  return fromBun(root, pkg) ?? fromNpm(root, pkg);
}

/** `undici (high) — ...` -> `undici`; null when the message does not name a package. */
export function packageFromAdvisory(message: string): string | null {
  const match = /^(@?[A-Za-z0-9._/-]+)\s*\(/.exec(message.trim());
  return match?.[1] ?? null;
}
