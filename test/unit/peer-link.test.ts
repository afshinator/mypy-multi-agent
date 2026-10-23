/**
 * Unit tests for the peer transport seam: the link is the only thing the
 * runtime sends through, so registration, silent drop for an unknown agent, and
 * destroy-then-forget are pinned here (#99).
 */
import { describe, expect, it, vi } from "vitest";
import {
  endpointFromBusPath,
  type PeerConnection,
  parsePeerEndpoint,
  UnixSocketLink,
} from "../../src/bus/peer-link";
import type { BusSocketServer } from "../../src/bus/socket-server";

function fakeConnection() {
  const written: string[] = [];
  const conn: PeerConnection = {
    destroyed: false,
    write: (line) => {
      written.push(line);
    },
    destroy: () => {
      (conn as { destroyed: boolean }).destroyed = true;
    },
    onConnect: () => {},
    onData: () => {},
    onClose: () => {},
    onError: () => {},
  };
  return { conn, written };
}

function stubBus() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as BusSocketServer;
}

describe("UnixSocketLink", () => {
  it("sends to a registered agent", () => {
    const link = new UnixSocketLink(stubBus());
    const { conn, written } = fakeConnection();
    link.register("a", conn);
    link.send("a", "line\n");
    expect(written).toEqual(["line\n"]);
  });

  it("drops a send to an unknown agent without throwing", () => {
    const link = new UnixSocketLink(stubBus());
    expect(() => {
      link.send("ghost", "line\n");
    }).not.toThrow();
  });

  it("sendAll writes to every registered connection", () => {
    const link = new UnixSocketLink(stubBus());
    const a = fakeConnection();
    const b = fakeConnection();
    link.register("a", a.conn);
    link.register("b", b.conn);
    link.sendAll("broadcast\n");
    expect(a.written).toEqual(["broadcast\n"]);
    expect(b.written).toEqual(["broadcast\n"]);
  });

  it("destroy destroys the connection and forgets it", () => {
    const link = new UnixSocketLink(stubBus());
    const { conn } = fakeConnection();
    link.register("a", conn);
    link.destroy("a");
    expect(conn.destroyed).toBe(true);
    expect(link.has("a")).toBe(false);
  });

  it("has follows register and unregister", () => {
    const link = new UnixSocketLink(stubBus());
    const { conn } = fakeConnection();
    expect(link.has("a")).toBe(false);
    link.register("a", conn);
    expect(link.has("a")).toBe(true);
    link.unregister("a");
    expect(link.has("a")).toBe(false);
  });

  it("replaces a registered connection on re-register", () => {
    const link = new UnixSocketLink(stubBus());
    const first = fakeConnection();
    const second = fakeConnection();
    link.register("a", first.conn);
    link.register("a", second.conn);
    link.send("a", "line\n");
    expect(second.written).toEqual(["line\n"]);
    expect(first.written).toEqual([]);
  });

  it("destroys the current connection after re-register", () => {
    const link = new UnixSocketLink(stubBus());
    const first = fakeConnection();
    const second = fakeConnection();
    link.register("a", first.conn);
    link.register("a", second.conn);
    link.destroy("a");
    expect(second.conn.destroyed).toBe(true);
    expect(link.has("a")).toBe(false);
  });
});

describe("peer endpoint descriptor", () => {
  it("maps a bus path to a unix endpoint", () => {
    expect(endpointFromBusPath("/tmp/run/.a2a-agent-bus.sock")).toEqual({
      kind: "unix",
      path: "/tmp/run/.a2a-agent-bus.sock",
    });
  });

  it("accepts a well-formed unix descriptor", () => {
    expect(parsePeerEndpoint({ kind: "unix", path: "/tmp/bus.sock" })).toEqual({
      kind: "unix",
      path: "/tmp/bus.sock",
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => parsePeerEndpoint({ kind: "tcp", address: "127.0.0.1:1234" })).toThrow(
      /unsupported peer endpoint kind: tcp/,
    );
  });

  it("rejects a unix descriptor with no path", () => {
    expect(() => parsePeerEndpoint({ kind: "unix", path: "" })).toThrow(/non-empty path/);
  });

  it("rejects a non-object descriptor", () => {
    expect(() => parsePeerEndpoint("unix:/tmp/bus.sock")).toThrow(/must be an object/);
  });
});
