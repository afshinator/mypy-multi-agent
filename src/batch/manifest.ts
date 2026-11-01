/**
 * Batch manifest builder: one runnable session.yaml from a template plus an
 * accepted ask.
 *
 * The template decides everything about the run except the ask — roster, models,
 * permissions, budgets, attester, validation. This module replaces the ask and
 * the run id, then proves the serialized text still validates: plain
 * `stringify` frees a criterion like `- Fix: it works` to parse back as a map,
 * so the round trip, not the object, is what is checked (issue #179).
 */
import { parse, stringify } from "yaml";
import { parseSessionConfig } from "../contracts/session-schema";

export interface ManifestInput {
  /** The selected template's YAML text, not a path: this module does no I/O. */
  templateText: string;
  ask: {
    title: string;
    description: string;
    /** Already gate-safe: `normalizeDoD` has run and reported no problems. */
    definition_of_done: string[];
  };
  sessionId: string;
}

export function buildManifestText({ templateText, ask, sessionId }: ManifestInput): string {
  const template: unknown = parse(templateText);
  if (typeof template !== "object" || template === null) {
    throw new Error("template is not a YAML mapping");
  }
  const { session } = template as { session?: unknown };
  if (typeof session !== "object" || session === null) {
    throw new Error("template has no session block");
  }

  const manifest = { ...template, session: { ...session, id: sessionId }, ask };
  // lineWidth 0 keeps one criterion per line, so a generated manifest diffs.
  const text = stringify(manifest, { lineWidth: 0 });

  let validated: ReturnType<typeof parseSessionConfig>;
  try {
    validated = parseSessionConfig(parse(text), () => false);
  } catch (err) {
    throw new Error(`invalid manifest: ${(err as Error).message}`);
  }
  if (JSON.stringify(validated.ask.definition_of_done) !== JSON.stringify(ask.definition_of_done)) {
    throw new Error("manifest definition_of_done did not survive serialization");
  }
  return text;
}
