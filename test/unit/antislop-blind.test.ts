import { describe, expect, it } from "vitest";
import { assertNotBlindable, blindFindings, packetForPeer } from "../../scripts/antislop/blind";

const rows = [
  { id: "fallow:crap:src/a.ts:12:abc", path: "src/a.ts", line: 12, message: "cognitive 11" },
  {
    id: "aislop:ruff/I001:docs/b.py:1:def",
    path: "docs/b.py",
    line: 1,
    message: "un-sorted import",
  },
];

describe("blinded packets", () => {
  it("replaces the id with a salted hash and drops tool and rule identity", () => {
    const packet = blindFindings(rows, "s1");
    expect(packet.rows.map((r) => r.path)).toEqual(["src/a.ts", "docs/b.py"]);
    for (const row of packet.rows) expect(row.id).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(packet.rows[0] ?? {}).sort()).toEqual(["claim", "id", "line", "path"]);
  });

  it("leaks neither the tool name nor the rule id anywhere in what the peer reads", () => {
    const packet = blindFindings(rows, "s1");
    expect(assertNotBlindable(packet, ["fallow", "aislop", "crap", "ruff/I001"])).toEqual([]);
    expect(packetForPeer(packet)).not.toContain("crap");
  });

  it("keeps the claim verbatim so the thing being judged is still there", () => {
    expect(blindFindings(rows, "s1").rows[0]?.claim).toBe("cognitive 11");
  });

  it("is stable for one salt and different across salts, and the key joins back", () => {
    const a = blindFindings(rows, "s1");
    const b = blindFindings(rows, "s1");
    const c = blindFindings(rows, "s2");
    expect(a.rows[0]?.id).toBe(b.rows[0]?.id);
    expect(a.rows[0]?.id).not.toBe(c.rows[0]?.id);
    expect(a.key[a.rows[0]?.id ?? ""]).toBe("fallow:crap:src/a.ts:12:abc");
  });

  it("strips a rule id an analyzer wrote into its own message", () => {
    const raw = [
      {
        id: "fallow:unlisted_dependencies:src/a.ts:1:x",
        path: "src/a.ts",
        line: 1,
        message: "unlisted_dependencies: @viz-js/viz (imported in this file)",
        rule_id: "unlisted_dependencies",
      },
    ];
    const packet = blindFindings(raw, "s1");
    expect(packet.rows[0]?.claim).toBe("@viz-js/viz (imported in this file)");
    expect(assertNotBlindable(packet, ["unlisted_dependencies"])).toEqual([]);
  });

  it("detects a leak when a rule name survives in the claim", () => {
    const leaky = [{ id: "x:1", path: "a.ts", line: 1, message: "crap score 12" }];
    expect(assertNotBlindable(blindFindings(leaky, "s1"), ["crap"])).toEqual(["crap"]);
  });
});
