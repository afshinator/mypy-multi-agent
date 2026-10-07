/**
 * Unix-domain socket transport for the agent bus. Owns the socket path,
 * stale-socket cleanup, and the listener; src/runtime/runtime.ts owns the
 * connections and wiring. Not a protocol layer — frames are parsed downstream.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Conservative ceiling below typical Unix sun_path limits (104 on macOS). */
const MAX_SOCKET_PATH = 100;

export function resolveSocketPath(askDir: string): string {
  const preferred = join(askDir, ".a2a-agent-bus.sock");
  if (preferred.length < MAX_SOCKET_PATH) return preferred;
  const hash = createHash("sha256").update(askDir).digest("hex").slice(0, 16);
  // Path too long for sun_path: fall back to a short hashed name under the OS
  // temp dir, trading a non-obvious location for a working socket.
  return join(tmpdir(), `mypi-${hash}.sock`);
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock: Socket = connect(path);
    sock.setTimeout(200);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

export class BusSocketServer {
  readonly path: string;
  private server: Server | undefined;

  constructor(askDir: string) {
    this.path = resolveSocketPath(askDir);
  }

  async start(onConnection: (socket: Socket) => void): Promise<void> {
    if (existsSync(this.path)) {
      if (await isLive(this.path)) throw new Error(`bus already running at ${this.path}`);
      await unlink(this.path).catch(() => {});
    }
    const server = createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.path).catch(() => {});
  }
}
