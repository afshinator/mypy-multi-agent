/**
 * Declared scope: which paths count as the code under audit.
 *
 * A repo can track generated and fixture trees (data/, graphify-out/, agent config
 * directories), and they are not app source. Tools that take globs get them at
 * invocation; tools that cannot (biome resolves ignores from config and .gitignore only)
 * keep reporting there, so the sample is drawn from in-scope paths and everything else is
 * marked rather than deleted — the artifact still shows what the tool claimed.
 */

/** Glob to RegExp: supports `**`, `*` and `?`, which is all the ignore lists need. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` spans zero or more directories; a trailing `**` matches the rest.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchGlobs(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Split reported paths by whether the declared scope covers them. A path that appears
 * here matched a glob and was reported anyway, which means that tool cannot be told to
 * skip it from the command line — biome is the case that matters.
 */
export function partitionByScope(
  paths: string[],
  globs: string[],
): { outOfScope: string[]; inScope: string[] } {
  const outOfScope: string[] = [];
  const inScope: string[] = [];
  for (const path of paths) {
    if (matchGlobs(path, globs)) outOfScope.push(path);
    else inScope.push(path);
  }
  return { outOfScope, inScope };
}
