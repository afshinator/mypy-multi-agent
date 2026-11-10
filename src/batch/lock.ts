/**
 * The per-ticket prepare lock (#427). Two `prepare` processes on one ticket used to be able to
 * pass the record check together, spend, and then collide inside one attempt directory — or
 * delete an acceptance record the other had just written. The lock is a file beside the record,
 * claimed with the repo's exclusive-create idiom, so the exclusion is the filesystem's.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface LockHolder {
  pid: number;
  startedAt: number;
}

export interface PrepareLock {
  path: string;
  release(): void;
}

/** `<record>/<id>/locks/<ticket>.lock` — beside the record, never inside it: that tree is committed. */
export function prepareLockPath(batchDir: string, ticket: number): string {
  return join(batchDir, "locks", `${ticket}.lock`);
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

/** `EPERM` means the pid exists under another user, so it counts as alive: only a gone pid is stale. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Someone else removed it between the read and the unlink; the next claim decides.
  }
}

export type LockResult = { ok: true; lock: PrepareLock } | { ok: false; detail: string };

/**
 * Claim the ticket's prepare lock. A lock whose owner is gone is taken over — nobody is left to
 * write the record it guarded — while a live or unreadable owner is never evicted: age alone does
 * not steal it, and `--break-lock` is the operator's explicit word. The lock records the pid and
 * start time so a refusal can say who holds it.
 */
export function acquirePrepareLock(
  path: string,
  options: { breakLock?: boolean; startedAt?: number } = {},
): LockResult {
  mkdirSync(dirname(path), { recursive: true });
  const holder: LockHolder = { pid: process.pid, startedAt: options.startedAt ?? Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(holder, null, 2)}\n`, { flag: "wx" });
      return { ok: true, lock: { path, release: () => releasePrepareLock(path) } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const taken = readHolder(path);
    if (taken !== undefined && alive(taken.pid) && options.breakLock !== true) {
      return {
        ok: false,
        detail: `prepare lock held by pid ${taken.pid} since ${new Date(taken.startedAt).toISOString()} — pass --break-lock to take it`,
      };
    }
    unlinkQuietly(path);
  }
  return { ok: false, detail: `prepare lock is held: ${path}` };
}

/** Drop the lock only if this process still owns it: a takeover must not be undeleted by us. */
function releasePrepareLock(path: string): void {
  const held = readHolder(path);
  if (held !== undefined && held.pid !== process.pid) return;
  unlinkQuietly(path);
}
