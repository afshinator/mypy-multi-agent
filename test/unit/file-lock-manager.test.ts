/**
 * Unit tests for the file lock manager module.
 */
import { describe, expect, it } from "vitest";
import { FileLockManager } from "../../src/locks/file-lock-manager";

describe("FileLockManager", () => {
  it("acquire and release", async () => {
    const m = new FileLockManager();
    await m.acquire("a", "f1", 1000);
    expect(m.ownerOf("f1")).toBe("a");
    m.release("a", "f1");
    expect(m.ownerOf("f1")).toBeUndefined();
  });

  it("second writer waits in FIFO order", async () => {
    const m = new FileLockManager();
    await m.acquire("a", "f1", 1000);
    const b = m.acquire("b", "f1", 1000);
    const c = m.acquire("c", "f1", 1000);
    m.release("a", "f1");
    await b;
    expect(m.ownerOf("f1")).toBe("b");
    m.release("b", "f1");
    await c;
    expect(m.ownerOf("f1")).toBe("c");
  });

  it("second lock request rejected while first held", async () => {
    const m = new FileLockManager();
    await m.acquire("a", "f1", 1000);
    await expect(m.acquire("a", "f2", 1000)).rejects.toThrow();
  });

  it("acquisition timeout", async () => {
    const m = new FileLockManager();
    await m.acquire("a", "f1", 1000);
    await expect(m.acquire("b", "f1", 20)).rejects.toThrow();
  });

  it("releaseAll frees the held lock so the next writer proceeds", async () => {
    const m = new FileLockManager();
    await m.acquire("a", "f1", 1000);
    const b = m.acquire("b", "f1", 1000);
    m.releaseAll("a");
    await b;
    expect(m.ownerOf("f1")).toBe("b");
  });

  it("releaseAll rejects a waiting agent's request", async () => {
    const m = new FileLockManager();
    await m.acquire("a", "f1", 1000);
    const b = m.acquire("b", "f1", 1000);
    m.releaseAll("b");
    await expect(b).rejects.toThrow();
  });
});
