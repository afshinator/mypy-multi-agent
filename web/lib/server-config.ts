import { parse } from "yaml";

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

export function parseServerConfig(text: string, home: string): { projectsDir: string } {
  const yamlText = text.replace(
    /(^|\n)([ \t]*projectsDir:[ \t]*)~([ \t]*(?:#.*)?)(?=\n|$)/,
    "$1$2'~'$3",
  );
  const value: unknown = parse(yamlText);
  if (
    typeof value !== "object" ||
    value === null ||
    !("projectsDir" in value) ||
    typeof value.projectsDir !== "string"
  ) {
    throw new Error("inspector.yaml must define a string projectsDir");
  }
  return { projectsDir: expandHome(value.projectsDir, home) };
}

export function resolveWithinRoot(root: string, path: string): string | null {
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) return null;

  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const segments = normalizedRoot.split("/").filter(Boolean);
  const rootDepth = segments.length;
  for (const segment of normalizedPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === rootDepth) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const prefix = normalizedRoot.startsWith("/") ? "/" : "";
  return `${prefix}${segments.join("/")}` || "/";
}
