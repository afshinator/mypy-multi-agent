/**
 * Unit tests for the peer-side file lock (issue #40): the peer must ask the
 * runtime for the file, wait for the grant, and block the tool call if the file
 * stays taken.
 */
import { describe, expect, it } from "vitest";
import type { A2AEnvelope } from "../../src/contracts/a2a-schema";
import { FileLock, lockWaitMs } from "../../src/peer/file-lock";
import { handleInboundLine } from "../../src/peer/peer-harness";

interface LockPayload {
  agentId?: string;
  filePath?: string;
  lockId?: string;
}

const grant = (lockId: string): A2AEnvelope => ({
  id: `lock-${lockId}`,
  timestamp: 0,
  sender: "bus",
  recipient: "peer1",
  type: "LOCK_ACQUIRED",
  payload: { agentId: "peer1", filePath: "a.txt", lockId },
});

function harness(timeoutMs = 50) {
  const sent: A2AEnvelope[] = [];
  const lock = new FileLock("peer1", (env) => sent.push(env), timeoutMs);
  return { lock, sent };
}

function firstOf(sent: A2AEnvelope[], type: A2AEnvelope["type"]): LockPayload {
  const found = sent.find((e) => e.type === type);
  if (found === undefined) throw new Error(`no ${type} was sent`);
  return found.payload as LockPayload;
}

function lastOf(sent: A2AEnvelope[], type: A2AEnvelope["type"]): LockPayload {
  const found = sent.filter((e) => e.type === type).at(-1);
  if (found === undefined) throw new Error(`no ${type} was sent`);
  return found.payload as LockPayload;
}

describe("lockWaitMs (issue #133)", () => {
  it("derives the peer's wait from the runtime's bound plus a fixed margin", () => {
    expect(lockWaitMs(30000)).toBe(35000);
    expect(lockWaitMs(60000)).toBe(65000);
  });
});

describe("FileLock", () => {
  it("asks for the file and proceeds once the runtime grants it", async () => {
    const { lock, sent } = harness();
    const pending = lock.request("call-1", "a.txt");
    expect(firstOf(sent, "LOCK_REQUEST").filePath).toBe("a.txt");
    lock.onFrame(grant(firstOf(sent, "LOCK_REQUEST").lockId ?? ""));
    await expect(pending).resolves.toBe(true);
  });

  it("locks the resolved absolute path, so two peers spelling it differently agree", () => {
    const sent: A2AEnvelope[] = [];
    const lock = new FileLock(
      "peer1",
      (env) => sent.push(env),
      50,
      (p) => `/repo/${p}`,
    );
    void lock.request("call-1", "a.txt");
    expect(firstOf(sent, "LOCK_REQUEST").filePath).toBe("/repo/a.txt");
  });

  it("refuses the call when no grant arrives in time", async () => {
    const { lock } = harness(30);
    await expect(lock.request("call-1", "a.txt")).resolves.toBe(false);
  });

  it("treats a correlated ERROR as a refusal", async () => {
    const { lock, sent } = harness();
    const pending = lock.request("call-1", "a.txt");
    const error: A2AEnvelope = {
      id: "e1",
      correlationId: firstOf(sent, "LOCK_REQUEST").lockId,
      timestamp: 0,
      sender: "bus",
      recipient: "peer1",
      type: "ERROR",
      payload: { code: "F2_INVALID_PAYLOAD", message: "invalid payload" },
    };
    lock.onFrame(error);
    await expect(pending).resolves.toBe(false);
  });

  it("settles an in-flight request false on a LOCK_REFUSED frame carrying its lock id (issue #133)", async () => {
    // 60s bound: the refusal frame must settle the waiter, not the timer.
    const { lock, sent } = harness(60_000);
    const pending = lock.request("call-1", "a.txt");
    lock.onFrame({
      id: `ref-${firstOf(sent, "LOCK_REQUEST").lockId}`,
      timestamp: 0,
      sender: "bus",
      recipient: "peer1",
      type: "LOCK_REFUSED",
      payload: {
        agentId: "peer1",
        filePath: "a.txt",
        lockId: firstOf(sent, "LOCK_REQUEST").lockId,
      },
    });
    await expect(pending).resolves.toBe(false);
  });

  it("routes a LOCK_REFUSED bus line to the lock frame handler (issue #133)", async () => {
    // Through the harness's inbound dispatch, not onFrame directly: the frame
    // must reach the lock like LOCK_ACQUIRED does, or a refusal is silence.
    const sent: A2AEnvelope[] = [];
    const lock = new FileLock("peer1", (env) => sent.push(env), 60_000);
    const pending = lock.request("call-1", "a.txt");
    const lockId = firstOf(sent, "LOCK_REQUEST").lockId ?? "";
    handleInboundLine(
      `${JSON.stringify({
        id: `ref-${lockId}`,
        timestamp: 0,
        sender: "bus",
        recipient: "peer1",
        type: "LOCK_REFUSED",
        payload: { agentId: "peer1", filePath: "a.txt", lockId },
      })}\n`,
      {
        agentId: "peer1",
        runTurn: async () => ({ report: "" }),
        send: () => {},
        stop: () => {},
        onDone: () => {},
        onError: () => {},
        onLockFrame: (env) => lock.onFrame(env),
      },
    );
    const settled = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("refusal frame never settled the waiter")), 2_000),
      ),
    ]);
    expect(settled).toBe(false);
  });

  it("releases the lock when the tool call finishes", async () => {
    const { lock, sent } = harness();
    const pending = lock.request("call-1", "a.txt");
    lock.onFrame(grant(firstOf(sent, "LOCK_REQUEST").lockId ?? ""));
    await pending;
    lock.release("call-1");
    expect(lastOf(sent, "LOCK_RELEASED").filePath).toBe("a.txt");
  });

  it("releases nothing for a call that never took a lock", () => {
    const { lock, sent } = harness();
    lock.release("call-1");
    expect(sent).toHaveLength(0);
  });

  // The runtime grants one lock per agent and swallows the refusal, so a batch
  // of two mutating calls must queue rather than race for a second lock.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const requests = (sent: A2AEnvelope[]) => sent.filter((e) => e.type === "LOCK_REQUEST");

  it("queues a second call in the same batch until the first releases", async () => {
    const { lock, sent } = harness();
    const first = lock.request("call-1", "a.txt");
    lock.onFrame(grant(firstOf(sent, "LOCK_REQUEST").lockId ?? ""));
    await expect(first).resolves.toBe(true);

    const second = lock.request("call-2", "b.txt");
    await tick();
    expect(requests(sent)).toHaveLength(1);

    lock.release("call-1");
    await tick();
    expect(requests(sent)).toHaveLength(2);
    expect(lastOf(sent, "LOCK_REQUEST").filePath).toBe("b.txt");
    lock.onFrame(grant(lastOf(sent, "LOCK_REQUEST").lockId ?? ""));
    await expect(second).resolves.toBe(true);
  });

  it("refuses a queued call when the holder never releases", async () => {
    const { lock, sent } = harness(30);
    const first = lock.request("call-1", "a.txt");
    lock.onFrame(grant(firstOf(sent, "LOCK_REQUEST").lockId ?? ""));
    await expect(first).resolves.toBe(true);

    await expect(lock.request("call-2", "b.txt")).resolves.toBe(false);
    expect(requests(sent)).toHaveLength(1);
  });
});
