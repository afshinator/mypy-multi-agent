/**
 * pi extension registering web_fetch, giving a peer web research without
 * granting shell.
 */
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CHARS = 50_000;

export function webTool(): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "web_fetch",
      label: "Web fetch",
      description: "Fetch a URL and return its text (truncated). For web research; use http/https URLs.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params): Promise<AgentToolResult> => {
        const { url } = params as { url: string };
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { content: [{ type: "text", text: `invalid url: ${url}` }], details: undefined };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { content: [{ type: "text", text: "only http/https URLs are allowed" }], details: undefined };
        }
        const res = await fetch(parsed.toString(), { headers: { "user-agent": "pi-peer/1.0" }, redirect: "follow" });
        if (!res.ok) {
          return { content: [{ type: "text", text: `fetch failed: ${res.status} ${res.statusText}` }], details: undefined };
        }
        const text = await res.text();
        const truncated =
          text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…[truncated ${text.length - MAX_CHARS} chars]` : text;
        return { content: [{ type: "text", text: truncated }], details: undefined };
      },
    });
  };
}
