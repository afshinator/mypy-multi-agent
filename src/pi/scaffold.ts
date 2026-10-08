/**
 * Session scaffolder (portability seam D/F): copy the portable template into
 * `.mypi/<task>/session.yaml` and fill `validation.commands` from stack
 * detection, so starting a run in a new repo needs no hand-written config. A
 * `.mypi/.gitignore` keeps run output out of the host repo. Never overwrites.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectStack } from "../stack/stack-profile";

/** Replace the template's empty validation list with the detected commands. */
export function withValidation(template: string, validation: readonly string[]): string {
  const replacement = validation.length
    ? `  commands:\n${validation.map((c) => `    - ${JSON.stringify(c)}`).join("\n")}`
    : "  commands: []";
  return template.replace(/^ {2}commands: \[\]$/m, replacement);
}

/** A filesystem-safe task name that can never escape `.mypi/`. */
export function safeTaskName(name: string): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "task" : slug;
}

/**
 * Write `.mypi/<taskName>/session.yaml` from `templatePath` with detected
 * validation. `wx` on the write: an existing session.yaml is never clobbered.
 */
export async function scaffoldSession(
  dir: string,
  templatePath: string,
  taskName = "task",
): Promise<string> {
  const [profile, template] = await Promise.all([detectStack(dir), readFile(templatePath, "utf8")]);
  const taskDir = join(dir, ".mypi", safeTaskName(taskName));
  await mkdir(taskDir, { recursive: true });
  const target = join(taskDir, "session.yaml");
  await writeFile(target, withValidation(template, profile.validation), { flag: "wx" });
  // Run output is transient; the task config is not. Ignore only the former.
  await writeFile(join(dir, ".mypi", ".gitignore"), "run-details/\n", { flag: "wx" }).catch(
    () => {},
  );
  return target;
}
