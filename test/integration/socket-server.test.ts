/**
 * Integration test: socket server across the wired runtime.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { BusSocketServer, resolveSocketPath } from "../../src/bus/socket-server";

describe("resolveSocketPath", () => {
  it("prefers session-local path when short", () => {
    expect(resolveSocketPath("/tmp/ask")).toBe("/tmp/ask/.a2a-agent-bus.sock");
  });

  it("falls back to tmpdir hash when too long", () => {
    const long = "/" + "a".repeat(120);
    const p = resolveSocketPath(long);
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p).toContain("mypi-");
  });
});

describe("BusSocketServer", () => {
  let dir: string | undefined;
  let server: BusSocketServer | undefined;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("start, connect, stop removes socket", async () => {
    dir = await mkdtemp(join(tmpdir(), "bus-test-"));
    server = new BusSocketServer(dir);
    await server.start(() => {});
    expect(existsSync(server.path)).toBe(true);
    const path = server.path;
    await server.stop();
    expect(existsSync(path)).toBe(false);
  });

  it("cleans a stale socket file", async () => {
    dir = await mkdtemp(join(tmpdir(), "bus-test-"));
    await writeFile(join(dir, ".a2a-agent-bus.sock"), "stale");
    server = new BusSocketServer(dir);
    await server.start(() => {});
    expect(existsSync(server.path)).toBe(true);
  });

  it("a client can connect and send a frame", async () => {
    dir = await mkdtemp(join(tmpdir(), "bus-test-"));
    server = new BusSocketServer(dir);
    const received: string[] = [];
    await server.start((socket) => socket.on("data", (d) => received.push(d.toString())));
    const client = connect(server.path);
    await new Promise<void>((res) => client.once("connect", () => res()));
    client.write('{"a":1}\n');
    await new Promise((res) => setTimeout(res, 100));
    expect(received.join("")).toBe('{"a":1}\n');
    client.destroy();
  });
});
