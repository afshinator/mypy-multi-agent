import { describe, expect, it } from "vitest";
import { failFirstChat, stripHopHeaders } from "../../scripts/one-shot-proxy";

describe("failFirstChat (issue #5)", () => {
  it("fails exactly the first chat call, whatever came before it", () => {
    // A non-chat preflight (e.g. /models) must not consume the failure.
    expect(failFirstChat(false, 0)).toBe(false);
    expect(failFirstChat(false, 1)).toBe(false);
    expect(failFirstChat(true, 1)).toBe(true);
  });

  it("never fails again, so attempt 2 is the real provider", () => {
    expect(failFirstChat(true, 2)).toBe(false);
    expect(failFirstChat(true, 3)).toBe(false);
  });
});

describe("stripHopHeaders", () => {
  it("drops framing headers and keeps the rest", () => {
    expect(
      stripHopHeaders({
        "content-type": "text/event-stream",
        "content-length": "12",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "x-request-id": "r1",
      }),
    ).toEqual({ "content-type": "text/event-stream", "x-request-id": "r1" });
  });

  it("does not mutate its input", () => {
    const headers = { "content-length": "1", "content-type": "application/json" };
    stripHopHeaders(headers);
    expect(headers).toEqual({ "content-length": "1", "content-type": "application/json" });
  });
});
