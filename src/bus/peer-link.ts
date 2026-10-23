/**
 * Destination-neutral peer transport seam. The runtime reaches peers through a
 * PeerLink, never through a socket directly. The unix-domain socket is one
 * implementation (UnixSocketLink); an address-based transport is another, and
 * adding it means adding an implementation and a PeerEndpoint kind, not a
 * branch in the runtime. Not a protocol layer — frames are parsed downstream.
 */
import type { Socket } from "node:net";
import type { BusSocketServer } from "./socket-server";

/** What the runtime needs from an accepted peer connection. */
export interface PeerConnection {
  readonly destroyed: boolean;
  write(line: string): void;
  destroy(): void;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: () => void): void;
}

/** How a peer is reached. `unix` is the only kind today. */
export type PeerEndpoint = { kind: "unix"; path: string };

/**
 * Send-side view the runtime holds: register on AGENT_REGISTER, unregister on
 * disconnect. A send to an unknown agent drops silently, as the in-process map
 * always did (K5), so callers must not treat `send` as delivery.
 */
export interface PeerLink {
  start(onConnection: (connection: PeerConnection) => void): Promise<void>;
  stop(): Promise<void>;
  register(agentId: string, connection: PeerConnection): void;
  unregister(agentId: string): void;
  has(agentId: string): boolean;
  send(agentId: string, line: string): void;
  sendAll(line: string): void;
  /** Destroy the agent's connection and forget it, in that order. */
  destroy(agentId: string): void;
}

/** The only place node socket events are read. */
function adapt(socket: Socket): PeerConnection {
  return {
    get destroyed() {
      return socket.destroyed;
    },
    write: (line) => {
      socket.write(line);
    },
    destroy: () => {
      socket.destroy();
    },
    onData: (listener) => {
      socket.on("data", (chunk) => {
        listener(chunk.toString());
      });
    },
    onClose: (listener) => {
      socket.on("close", () => {
        listener();
      });
    },
    onError: (listener) => {
      // A peer that dies or is contained by the protocol-fault breaker is not a
      // runtime failure; the listener exists so a destroyed-socket write does
      // not raise.
      socket.on("error", () => {
        listener();
      });
    },
  };
}

/** Local peer transport over the run's unix-domain socket bus. */
export class UnixSocketLink implements PeerLink {
  private readonly byAgent = new Map<string, PeerConnection>();

  constructor(private readonly bus: BusSocketServer) {}

  async start(onConnection: (connection: PeerConnection) => void): Promise<void> {
    await this.bus.start((socket) => onConnection(adapt(socket)));
  }

  async stop(): Promise<void> {
    this.byAgent.clear();
    await this.bus.stop();
  }

  register(agentId: string, connection: PeerConnection): void {
    this.byAgent.set(agentId, connection);
  }

  unregister(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  send(agentId: string, line: string): void {
    this.byAgent.get(agentId)?.write(line);
  }

  sendAll(line: string): void {
    for (const connection of this.byAgent.values()) connection.write(line);
  }

  destroy(agentId: string): void {
    this.byAgent.get(agentId)?.destroy();
    this.byAgent.delete(agentId);
  }
}
