/**
 * Launch seam: where a peer process starts is an implementation. The herdr pane
 * launcher is the only one today; an address-based destination (container, VM)
 * adds an implementation plus its own transport, not a branch in the runtime.
 * What to run and from which directory stays the runtime's business.
 */
import type { HerdrClient } from "../herdr/herdr-client";
import { PaneManager } from "../herdr/pane-manager";

/** One peer to start: the agent it belongs to and its exact command line. */
export interface PeerSpec {
  agentId: string;
  command: string;
}

export interface PeerLauncher {
  /** Start every peer, as close together as the destination allows. */
  launchAll(peers: readonly PeerSpec[], cwd?: string): Promise<void>;
  /** Restart one peer in its existing place, or start it if it has none. */
  respawn(agentId: string, command: string): Promise<void>;
  terminate(agentId: string): Promise<void>;
  /** Best effort over every peer; rethrows the first failure once all are tried. */
  terminateAll(): Promise<void>;
}

/** Local launching: one herdr pane per peer. */
export class HerdrPeerLauncher implements PeerLauncher {
  private readonly panes: PaneManager;

  constructor(client: HerdrClient, supervisorPaneId = process.env.HERDR_PANE_ID) {
    this.panes = new PaneManager(client, supervisorPaneId);
  }

  launchAll(peers: readonly PeerSpec[], cwd?: string): Promise<void> {
    return this.panes.spawnAll([...peers], cwd);
  }

  respawn(agentId: string, command: string): Promise<void> {
    return this.panes.respawn(agentId, command);
  }

  terminate(agentId: string): Promise<void> {
    return this.panes.terminate(agentId);
  }

  terminateAll(): Promise<void> {
    return this.panes.terminateAll();
  }
}
