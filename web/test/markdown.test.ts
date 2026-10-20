import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../lib/markdown";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("renderMarkdown", () => {
  it("escapes raw HTML in plan/findings samples", () => {
    for (const md of [fixture("plan-sample.md"), fixture("findings-sample.md")]) {
      const html = renderMarkdown(md);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;");
    }
  });

  it("renders markdown headings and lists", () => {
    const html = renderMarkdown("# Title\n\n- one\n- two\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });
});
