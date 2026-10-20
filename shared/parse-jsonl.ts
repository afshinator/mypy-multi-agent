/**
 * Pure JSONL line parsing, shared by the runner and the run inspector.
 * Text in, records out; no fs and no node/bun imports.
 */

/**
 * Parse JSONL text into records: one JSON object per line, blank and malformed
 * lines skipped, non-object lines (numbers, null, arrays) ignored. The single
 * reader for every JSONL artifact (issue #31) — callers validate fields; this
 * only parses.
 */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A malformed line is skipped; consumers judge what parsed.
    }
  }
  return out;
}
