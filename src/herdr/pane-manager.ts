/**
 * Maps agents to herdr panes and owns their lifecycle: balanced grid spawn and
 * terminate. Consumed by Runtime.spawnPeers.
 */
import type { HerdrClient } from "./herdr-client";

export interface Spawnable {
  agentId: string;
  command: string;
}

export class PaneManager {
  private panes = new Map<string, string>(); // agentId -> paneId

  constructor(
    private readonly client: HerdrClient,
    private readonly supervisorPaneId = process.env.HERDR_PANE_ID,
  ) {}

  /** Spawn one agent into a right split of the calling pane. */
  async spawn(agentId: string, command: string): Promise<string> {
    const paneId = await this.client.createPane({ direction: "right" });
    this.panes.set(agentId, paneId);
    await this.client.runCommand(paneId, command);
    return paneId;
  }

  /**
   * Spawn all peers into a balanced near-square grid (cols ≈ √N) so panes stay
   * roughly equal for any peer count. Falls back to per-agent right splits when
   * the supervisor pane id is unknown (e.g. outside herdr).
   */
  async spawnAll(agents: Spawnable[], cwd?: string): Promise<void> {
    if (!this.supervisorPaneId || agents.length === 0) {
      for (const a of agents) await this.spawn(a.agentId, a.command);
      return;
    }
    const n = agents.length + 1; // supervisor + peers
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const rowPanes = await this.splitEqual(this.supervisorPaneId, rows, "down", cwd);
    const cells: string[] = [];
    for (const row of rowPanes) cells.push(...(await this.splitEqual(row, cols, "right", cwd)));
    for (let i = 0; i < agents.length; i++) {
      const paneId = cells[i + 1]!; // cell (0,0) is the supervisor
      this.panes.set(agents[i]!.agentId, paneId);
      await this.client.runCommand(paneId, agents[i]!.command);
    }
  }

  paneOf(agentId: string): string | undefined {
    return this.panes.get(agentId);
  }

  async terminate(agentId: string): Promise<void> {
    const paneId = this.panes.get(agentId);
    if (paneId === undefined) return;
    // Only unmap after a successful close: a rejected closePane() leaves the
    // pane running, and keeping the mapping lets terminateAll retry it instead
    // of silently orphaning an untracked pane.
    await this.client.closePane(paneId);
    this.panes.delete(agentId);
  }

  // Best-effort over every pane: a sequential loop would stop at the first
  // closePane() rejection and leave the rest running and untracked. Attempt
  // all, then rethrow the first failure so callers still learn termination
  // was incomplete.
  async terminateAll(): Promise<void> {
    const results = await Promise.allSettled([...this.panes.keys()].map((agentId) => this.terminate(agentId)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
  }

  /** Split `paneId` into `count` equal panes along `direction`; returns them in order. */
  private async splitEqual(paneId: string, count: number, direction: "right" | "down", cwd?: string): Promise<string[]> {
    if (count <= 1) return [paneId];
    const newPane = await this.client.createPane({ paneId, direction, ratio: (count - 1) / count, cwd });
    const rest = await this.splitEqual(paneId, count - 1, direction, cwd);
    return [...rest, newPane];
  }
}
