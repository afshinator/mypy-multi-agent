import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The environment files a clone must not carry. `cp -R` copies ignored files too, and a Next.js
 * repository keeps production credentials in a gitignored `.env.local` beside the code — so an
 * unfiltered copy hands a model the database URL, the cron secret and the mail token (#500 review).
 * Templates stay: they hold names, not values.
 */
const ENV_FILE = ".env*";

/**
 * A throwaway copy of the repository for one prepare: the code the triage and the verifier read,
 * with every real `.env` file removed first.
 */
export function makeClone(repoRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mypi-triage-"));
  // `-c` is the APFS clonefile flag: it makes the copy instant on macOS and GNU cp rejects it, so
  // the clone never worked on Linux until the test above ran there (CI: "invalid option -- 'c'").
  const fast = process.platform === "darwin" ? ["-c"] : [];
  execFileSync("cp", ["-R", ...fast, `${repoRoot}/.`, dir]);
  execFileSync("find", [dir, "-name", ENV_FILE, "-not", "-name", "*.example", "-delete"]);
  return dir;
}

export function removeClone(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
