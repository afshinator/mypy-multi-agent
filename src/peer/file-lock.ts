/**
 * Peer-side file locking (issue #40). The runtime already grants LOCK_REQUEST,
 * queues FIFO and frees a lock on disconnect, but no peer ever asked, so two
 * peers could edit one file concurrently. This asks for the file around every
 * edit/write and blocks the tool call when the lock cannot be had.
 */
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { A2AEnvelope } from "../contracts/a2a-schema";

/** Longer than the runtime's 30s acquire bound, so a grant is never missed. */
const ACQUIRE_TIMEOUT_MS = 35_000;

interface Held {
  lockId: string;
  path: string;
}

export class FileLock {
  private seq = 0;
  private readonly waiters = new Map<string, (granted: boolean) => void>();
  private readonly held = new Map<string, Held>(); // toolCallId -> lock

  constructor(
    private readonly agentId: string,
    private readonly send: (env: A2AEnvelope) => void,
    private readonly timeoutMs = ACQUIRE_TIMEOUT_MS,
    /** Lock keys must agree across peers: resolve to one absolute path. */
    private readonly resolvePath: (path: string) => string = (p) => p,
  ) {}

  /** Take the lock for `path` and attach it to `toolCallId`; false on refusal. */
  async request(toolCallId: string, rawPath: string): Promise<boolean> {
    const lockId = `${this.agentId}-${++this.seq}`;
    const path = this.resolvePath(rawPath);
    const granted = await this.acquire(lockId, path);
    if (granted) this.held.set(toolCallId, { lockId, path });
    return granted;
  }

  /** Release whatever lock this tool call took, if any. */
  release(toolCallId: string): void {
    const held = this.held.get(toolCallId);
    if (held === undefined) return;
    this.held.delete(toolCallId);
    this.send({
      id: `rel-${held.lockId}`,
      timestamp: Date.now(),
      sender: this.agentId,
      recipient: "supervisor",
      type: "LOCK_RELEASED",
      payload: { agentId: this.agentId, filePath: held.path },
    });
  }

  /** Route a bus frame here; a grant or a correlated error settles its waiter. */
  onFrame(env: A2AEnvelope): void {
    const payload = env.payload as { lockId?: string; correlationId?: string };
    const lockId = payload.lockId ?? payload.correlationId;
    if (lockId === undefined) return;
    this.settle(lockId, env.type === "LOCK_ACQUIRED");
  }

  private acquire(lockId: string, path: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(lockId);
        resolve(false);
      }, this.timeoutMs);
      this.waiters.set(lockId, (granted) => {
        clearTimeout(timer);
        resolve(granted);
      });
      this.send({
        id: `lock-${lockId}`,
        timestamp: Date.now(),
        sender: this.agentId,
        recipient: "supervisor",
        type: "LOCK_REQUEST",
        payload: { agentId: this.agentId, filePath: path, lockId },
      });
    });
  }

  private settle(lockId: string, granted: boolean): void {
    const waiter = this.waiters.get(lockId);
    if (waiter === undefined) return;
    this.waiters.delete(lockId);
    waiter(granted);
  }
}

/** pi extension: lock around edit/write, block the call when the lock is refused. */
export function fileLock(lock: FileLock): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const path = isToolCallEventType("edit", event)
        ? event.input.path
        : isToolCallEventType("write", event)
          ? event.input.path
          : undefined;
      if (path === undefined) return undefined;
      if (await lock.request(event.toolCallId, path)) return undefined;
      return { block: true, reason: `another peer holds ${path}; retry after it reports` };
    });
    pi.on("tool_execution_end", (event) => lock.release(event.toolCallId));
  };
}
