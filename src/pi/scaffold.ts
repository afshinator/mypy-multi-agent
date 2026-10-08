/**
 * Session scaffolder (portability seam D/F): copy the portable template into a
 * target repo and fill `validation.commands` from stack detection, so starting
 * a run in a new repo needs no hand-written config. Never overwrites an
 * existing session.yaml.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectStack } from "../stack/stack-profile";

/** Replace the template's empty validation list with the detected commands. */
export function withValidation(template: string, validation: readonly string[]): string {
  const replacement = validation.length
    ? `  commands:\n${validation.map((c) => `    - ${JSON.stringify(c)}`).join("\n")}`
    : "  commands: []";
  return template.replace(/^ {2}commands: \[\]$/m, replacement);
}

/** Write `<dir>/session.yaml` from `templatePath` with detected validation. */
export async function scaffoldSession(dir: string, templatePath: string): Promise<string> {
  const [profile, template] = await Promise.all([detectStack(dir), readFile(templatePath, "utf8")]);
  const target = join(dir, "session.yaml");
  // wx: a scaffold must never clobber a session.yaml the user already wrote.
  await writeFile(target, withValidation(template, profile.validation), { flag: "wx" });
  return target;
}
