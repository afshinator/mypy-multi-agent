/**
 * Unit tests for the pure JSONL line parser (shared/parse-jsonl.ts).
 */
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../shared/parse-jsonl";

describe("parseJsonl", () => {
  it("parses one JSON object per line, skipping blank, malformed, and non-object lines", () => {
    const text = '{"a":1}\n\n{"a":2}\n not json \n{"a":3}\n123\nnull\n[1,2]\n{"a":4}\r\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
  });
});
