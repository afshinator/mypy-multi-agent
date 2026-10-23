/**
 * Destination-neutral peer transport seam. The runtime reaches peers through a
 * PeerLink, never through a socket directly. The unix-domain socket is one
 * implementation (UnixSocketLink); an address-based transport is another, and
 * adding it means adding an implementation and a PeerEndpoint kind, not a
 * branch in the runtime. Not a protocol layer — frames are parsed downstream.
 */
import type { Socket } from "node:net";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { BusSocketServer } from "./socket-server";

/** What the runtime needs from an accepted peer connection. */
export interface PeerConnection {
  readonly destroyed: boolean;
  write(line: string): void;
  destroy(): void;
  onConnect(listener: () => void): void;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (err: Error) => void): void;
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

/** The only place node socket events are read, on either end of the link. */
function adapt(socket: Socket): PeerConnection {
  // One decoder per connection: a chunk boundary can split a multibyte character,
  // and decoding per chunk would corrupt it.
  const decoder = new StringDecoder("utf8");
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
    onConnect: (listener) => {
      // An already-connected socket never re-emits "connect", so a listener
      // attached after a dial resolves would hang the peer with no register.
      if (!socket.connecting) {
        queueMicrotask(listener);
        return;
      }
      socket.on("connect", () => {
        listener();
      });
    },
    onData: (listener) => {
      socket.on("data", (chunk) => {
        listener(decoder.write(chunk));
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
      // not raise, and so a dialling peer can print the reason.
      socket.on("error", (err) => {
        listener(err);
      });
    },
  };
}

/** Validate a descriptor that arrived as data (peer config, future CLI flag). */
export function parsePeerEndpoint(input: unknown): PeerEndpoint {
  if (typeof input !== "object" || input === null) {
    throw new Error("peer endpoint must be an object");
  }
  const { kind, path } = input as { kind?: unknown; path?: unknown };
  if (kind !== "unix") throw new Error(`unsupported peer endpoint kind: ${String(kind)}`);
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("unix peer endpoint needs a non-empty path");
  }
  return { kind, path };
}

/** The endpoint a run's bus path denotes; the default for a peer with no descriptor. */
export function endpointFromBusPath(busPath: string): PeerEndpoint {
  return { kind: "unix", path: busPath };
}

/** Dial side of the seam: the peer connects through this, never through net.connect. */
export function connectPeer(endpoint: PeerEndpoint): PeerConnection {
  const parsed = parsePeerEndpoint(endpoint);
  return adapt(connect(parsed.path));
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
