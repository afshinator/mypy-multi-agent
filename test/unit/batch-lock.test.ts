import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePrepareLock, prepareLockPath } from "../../src/batch/lock";

/** A pid no process can hold, so `process.kill(pid, 0)` reports it gone on every platform here. */
const DEAD_PID = 2_147_483_647;

let dir: string;
const lockPath = () => prepareLockPath(dir, 42);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mypi-lock-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A lock file as another process would have left it. */
const writeHolder = (pid: number, startedAt = Date.now()): void => {
  mkdirSync(join(dir, "locks"), { recursive: true });
  writeFileSync(lockPath(), `${JSON.stringify({ pid, startedAt })}\n`);
};

describe("prepare lock (#427)", () => {
  it("claims a free lock and releases it", () => {
    const locked = acquirePrepareLock(lockPath());
    expect(locked.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toMatchObject({ pid: process.pid });
    if (locked.ok) locked.lock.release();
    expect(() => readFileSync(lockPath(), "utf8")).toThrow();
  });

  it("refuses a lock whose owner is alive, and names it", () => {
    writeHolder(process.pid);

    const locked = acquirePrepareLock(lockPath());

    expect(locked).toMatchObject({ ok: false });
    if (!locked.ok) expect(locked.detail).toContain(`pid ${process.pid}`);
    // The winner's file is untouched: a refusal never edits someone else's lock.
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("takes over a lock whose owner is gone, without being asked", () => {
    writeHolder(DEAD_PID);

    const locked = acquirePrepareLock(lockPath());

    expect(locked.ok).toBe(true);
    if (locked.ok) locked.lock.release();
  });

  it("evicts a live lock only when the operator says --break-lock", () => {
    writeHolder(process.pid);

    const locked = acquirePrepareLock(lockPath(), { breakLock: true });

    expect(locked.ok).toBe(true);
    if (locked.ok) locked.lock.release();
  });

  it("does not steal on age alone: a lock is old or it is not, the pid decides", () => {
    writeHolder(process.pid, 0);

    expect(acquirePrepareLock(lockPath()).ok).toBe(false);
  });

  it("does not delete a lock another process now owns", () => {
    const locked = acquirePrepareLock(lockPath());
    if (!locked.ok) throw new Error("lock was not claimed");
    // The operator's --break-lock handed the lock to another pid between our claim and release.
    writeHolder(process.pid + 1);

    locked.lock.release();

    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toMatchObject({ pid: process.pid + 1 });
  });
});
