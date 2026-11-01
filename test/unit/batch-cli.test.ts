import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../../src/batch/cli";
import { parseRequest } from "../../src/batch/request";

let cwd: string;
const out: string[] = [];
const err: string[] = [];
const io = {
  get cwd() {
    return cwd;
  },
  out: (line: string) => out.push(line),
  err: (line: string) => err.push(line),
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mypi-batch-cli-"));
  out.length = 0;
  err.length = 0;
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("mypi-batch new", () => {
  it("writes a request the parser accepts", async () => {
    expect(await main(["new", "b1", "163", "164"], io)).toBe(0);

    const written = readFileSync(join(cwd, "batches/b1/request.yaml"), "utf8");
    expect(parseRequest(written)).toEqual({ id: "b1", tickets: [163, 164] });
    expect(out.join("\n")).toContain("batches/b1/request.yaml");
  });

  it("is write-once: an existing request is refused, not overwritten", async () => {
    expect(await main(["new", "b1", "163"], io)).toBe(0);
    expect(await main(["new", "b1", "164"], io)).toBe(1);

    expect(
      parseRequest(readFileSync(join(cwd, "batches/b1/request.yaml"), "utf8")).tickets,
    ).toEqual([163]);
    expect(err.join("\n")).toMatch(/already exists/);
  });

  it("refuses an id that would not survive as a directory name", async () => {
    expect(await main(["new", "B_1", "163"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/id/);
  });

  it("refuses a request with no tickets", async () => {
    expect(await main(["new", "b1"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: mypi-batch new/);
  });
});

describe("mypi-batch dispatch", () => {
  it("lists the verbs and exits 0 for --help", async () => {
    expect(await main(["--help"], io)).toBe(0);
    expect(out.join("\n")).toContain("new <id> <ticket...>");
  });

  it("refuses a verb that is not implemented yet instead of doing nothing", async () => {
    expect(await main(["prepare", "b1"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/unknown command "prepare"/);
    expect(err.join("\n")).toContain("new <id> <ticket...>");
  });
});
