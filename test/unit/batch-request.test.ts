import { describe, expect, it } from "vitest";
import { parseRequest, requestYaml } from "../../src/batch/request";

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
});

describe("requestYaml", () => {
  it("round-trips through the parser", () => {
    const request = { id: "b7", tickets: [190, 191], kind: "code-fix" };
    expect(parseRequest(requestYaml(request))).toEqual(request);
  });
});
