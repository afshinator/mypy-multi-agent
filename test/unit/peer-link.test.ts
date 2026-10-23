/**
 * Unit tests for the peer transport seam: the link is the only thing the
 * runtime sends through, so registration, silent drop for an unknown agent, and
 * destroy-then-forget are pinned here (#99).
 */
import { describe, expect, it, vi } from "vitest";
import { type PeerConnection, UnixSocketLink } from "../../src/bus/peer-link";
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
});
