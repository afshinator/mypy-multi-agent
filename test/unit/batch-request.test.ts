import { describe, expect, it } from "vitest";
import { batchTaskSlug, orderTickets, parseRequest, requestYaml } from "../../src/batch/request";

describe("batchTaskSlug", () => {
  it("keeps numeric batch order in task directories and preserves legacy ids", () => {
    expect(batchTaskSlug("0012-multi-49-45", 49)).toBe("0012-multi-49-45-t49");
    expect(batchTaskSlug("b7", 49)).toBe("b-b7-t49");
  });
});

describe("parseRequest", () => {
  it("reads the batch id, tickets and optional kind", () => {
    expect(parseRequest("id: b1\ntickets: [163, 164]\nkind: code-fix\n")).toEqual({
      id: "b1",
      tickets: [163, 164],
      kind: "code-fix",
    });
    expect(parseRequest("id: b1\ntickets: [163]\n").kind).toBeUndefined();
  });

  it("refuses an id a task directory could not carry", () => {
    for (const id of ["B1", "b_1", "../b1", "b 1", "", `b${"x".repeat(60)}`]) {
      expect(() => parseRequest(`id: "${id}"\ntickets: [1]\n`), id).toThrow(/id/);
    }
  });

  it("refuses an empty ticket list, duplicates and non-numbers", () => {
    expect(() => parseRequest("id: b1\ntickets: []\n")).toThrow(/at least one ticket/);
    expect(() => parseRequest("id: b1\ntickets: [163, 163]\n")).toThrow(/duplicate ticket 163/);
    expect(() => parseRequest('id: b1\ntickets: ["163"]\n')).toThrow(/ticket/);
    expect(() => parseRequest("id: b1\ntickets: [0]\n")).toThrow(/ticket/);
  });

  it("reads dependsOn and refuses edges naming a ticket not in the request", () => {
    expect(parseRequest("id: b1\ntickets: [163, 164]\ndependsOn:\n  164: 163\n").dependsOn).toEqual(
      {
        164: 163,
      },
    );
    expect(() => parseRequest("id: b1\ntickets: [163]\ndependsOn:\n  163: 999\n")).toThrow(
      /not in the request/,
    );
    expect(() => parseRequest("id: b1\ntickets: [163]\ndependsOn:\n  999: 163\n")).toThrow(
      /not in the request/,
    );
  });

  it("refuses a self-dependency and a cycle", () => {
    expect(() => parseRequest("id: b1\ntickets: [163]\ndependsOn:\n  163: 163\n")).toThrow(
      /itself/,
    );
    expect(() =>
      parseRequest("id: b1\ntickets: [163, 164]\ndependsOn:\n  164: 163\n  163: 164\n"),
    ).toThrow(/cycle/);
  });

  it("orders a chain after its dependency and leaves unrelated tickets in place", () => {
    expect(orderTickets([163, 164, 165], { 164: 163 })).toEqual([163, 164, 165]);
    expect(orderTickets([165, 164, 163], { 165: 164, 164: 163 })).toEqual([163, 164, 165]);
  });
});

describe("requestYaml", () => {
  it("round-trips through the parser", () => {
    const request = { id: "b7", tickets: [190, 191], kind: "code-fix" };
    expect(parseRequest(requestYaml(request))).toEqual(request);
  });
});
