/**
 * Exact-file advisory locks with FIFO waiters and one-lock-per-agent deadlock
 * prevention. Runtime owns the single instance.
 */
interface Pending {
  agentId: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Exact-file locks with FIFO acquisition and deadlock prevention.
 * One lock per agent; an agent holding a lock cannot request another.
 */
export class FileLockManager {
  private owners = new Map<string, string>(); // filePath -> agentId
  private queues = new Map<string, Pending[]>(); // filePath -> FIFO waiters
  private held = new Map<string, string>(); // agentId -> filePath

  acquire(agentId: string, filePath: string, timeoutMs: number): Promise<void> {
    if (this.held.has(agentId)) {
      return Promise.reject(new Error(`agent ${agentId} already holds a lock`));
    }
    if (this.owners.get(filePath) === undefined) {
      this.grant(agentId, filePath);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        agentId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const q = this.queues.get(filePath) ?? [];
          const i = q.indexOf(pending);
          if (i >= 0) q.splice(i, 1);
          if (q.length === 0) this.queues.delete(filePath);
          reject(new Error(`lock acquisition timeout for ${filePath}`));
        }, timeoutMs),
      };
      const q = this.queues.get(filePath) ?? [];
      q.push(pending);
      this.queues.set(filePath, q);
    });
  }

  release(agentId: string, filePath: string): void {
    if (this.owners.get(filePath) !== agentId) return;
    this.owners.delete(filePath);
    this.held.delete(agentId);
    const q = this.queues.get(filePath);
    if (!q) return;
    const next = q.shift();
    if (next === undefined) return;
    if (q.length === 0) this.queues.delete(filePath);
    clearTimeout(next.timer);
    this.grant(next.agentId, filePath);
    next.resolve();
  }

  /** Crash/disconnect/stop/kill: free the held lock and reject the agent's pending wait. */
  releaseAll(agentId: string): void {
    const heldFile = this.held.get(agentId);
    if (heldFile !== undefined) this.release(agentId, heldFile);
    for (const [filePath, q] of this.queues) {
      const before = q.length;
      const rest = q.filter((p) => p.agentId !== agentId);
      if (rest.length !== before) {
        for (const p of q) {
          if (p.agentId === agentId) {
            clearTimeout(p.timer);
            p.reject(new Error(`agent ${agentId} released`));
          }
        }
        if (rest.length === 0) this.queues.delete(filePath);
        else this.queues.set(filePath, rest);
      }
    }
  }

  ownerOf(filePath: string): string | undefined {
    return this.owners.get(filePath);
  }

  private grant(agentId: string, filePath: string): void {
    this.owners.set(filePath, agentId);
    this.held.set(agentId, filePath);
  }
}
