import { describe, expect, it } from "vitest";
import { JsonlFramer } from "../../src/bus/jsonl-framer";

describe("JsonlFramer", () => {
  it("one frame per read", () => {
    const f = new JsonlFramer();
    expect(f.push('{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it("multiple frames in one read", () => {
    const f = new JsonlFramer();
    expect(f.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("frame split across reads", () => {
    const f = new JsonlFramer();
    expect(f.push('{"a":')).toEqual([]);
    expect(f.push('1}\n')).toEqual(['{"a":1}']);
  });

  it("empty lines skipped", () => {
    const f = new JsonlFramer();
    expect(f.push('\n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it("CRLF handled", () => {
    const f = new JsonlFramer();
    expect(f.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("flush returns the partial frame once", () => {
    const f = new JsonlFramer();
    f.push('{"a":');
    expect(f.flush()).toBe('{"a":');
    expect(f.flush()).toBeUndefined();
  });
});
