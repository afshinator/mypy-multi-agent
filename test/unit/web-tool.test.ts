import { describe, expect, it, vi, afterEach } from "vitest";
import { webTool } from "../../src/peer/web-tool";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function captureTool() {
  let tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> };
  const pi = { registerTool: vi.fn((t) => (tool = t)) } as unknown as ExtensionAPI;
  webTool()(pi);
  return { tool: tool!, pi };
}

afterEach(() => vi.unstubAllGlobals());

describe("webTool", () => {
  it("registers a web_fetch tool", () => {
    const { tool } = captureTool();
    expect(tool.name).toBe("web_fetch");
  });

  it("fetches an http(s) URL and returns its text", async () => {
    const { tool } = captureTool();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = (await tool.execute("id", { url: "https://example.com/x" })) as { content: { text: string }[] };
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/x", expect.anything());
    expect(result.content[0]!.text).toBe("hello");
  });

  it("rejects non-http(s) schemes", async () => {
    const { tool } = captureTool();
    const result = (await tool.execute("id", { url: "file:///etc/passwd" })) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("only http/https");
  });

  it("reports a failed fetch", async () => {
    const { tool } = captureTool();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found", text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = (await tool.execute("id", { url: "https://example.com/nope" })) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("404");
  });
});
