import type { HerdrClient } from "./herdr-client";

/** Maps agents to herdr panes and owns their lifecycle (spawn/terminate). */
export class PaneManager {
  private panes = new Map<string, string>(); // agentId -> paneId

  constructor(private readonly client: HerdrClient) {}

  async spawn(agentId: string, command: string): Promise<string> {
    const paneId = await this.client.createPane({ direction: "right" });
    this.panes.set(agentId, paneId);
    await this.client.runCommand(paneId, command);
    return paneId;
  }

  paneOf(agentId: string): string | undefined {
    return this.panes.get(agentId);
  }

  async terminate(agentId: string): Promise<void> {
    const paneId = this.panes.get(agentId);
    if (paneId === undefined) return;
    this.panes.delete(agentId);
    await this.client.closePane(paneId);
  }

  async terminateAll(): Promise<void> {
    for (const agentId of [...this.panes.keys()]) {
      await this.terminate(agentId);
    }
  }
}
