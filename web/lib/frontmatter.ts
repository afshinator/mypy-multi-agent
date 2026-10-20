import { parse as parseYaml } from "yaml";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a Markdown YAML frontmatter block into a record; {} when absent or malformed. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (block === undefined) return {};
  try {
    const parsed: unknown = parseYaml(block);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
