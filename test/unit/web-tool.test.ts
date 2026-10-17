/**
 * Unit tests for the web tool module.
 */

import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough } from "node:stream";
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateSync,
} from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webTool } from "../../src/peer/web-tool";

vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(
    async (host: string): Promise<{ address: string; family: number }[]> => [
      { address: host, family: 4 },
    ],
  ),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

type ToolResult = { content: { text: string }[] };
type MockResponse = {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Never emit "end": a response whose body never completes. */
  hang?: boolean;
};
type ConnectLookup = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (err: Error | null, address: unknown, family?: number) => void,
) => void;

/**
 * Canned responses shared by both network stubs: the http(s).request mock the
 * fixed implementation drives, and the global-fetch stand-in a fetch-based
 * implementation drives. Both serve the same fixtures, so a test's outcome
 * reflects the implementation under test, never the harness.
 */
let responses: MockResponse[] = [];
let fetchCalls = 0;

/** A fetch() stand-in's response: what a fetch-based implementation consumes. */
type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  text: () => Promise<string>;
};

const FETCH_REDIRECT_LIMIT = 20; // how many hops undici's fetch follows
const FETCH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The next canned response, repeating the last once the list runs out. */
function nextSpec(): MockResponse {
  return responses[Math.min(fetchCalls++, responses.length - 1)] ?? {
    status: 200,
    body: "ok",
  };
}

/** Decodes a fixture body the way fetch.text() does. */
function decodeBody(spec: MockResponse): string {
  const raw = spec.body === undefined ? Buffer.alloc(0) : Buffer.from(spec.body);
  const encoding = String(spec.headers?.["content-encoding"] ?? "").toLowerCase();
  if (encoding === "gzip") {
    return gunzipSync(raw).toString("utf8");
  }
  if (encoding === "deflate") {
    return inflateSync(raw).toString("utf8");
  }
  if (encoding === "br") {
    return brotliDecompressSync(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

/**
 * A realistic global fetch: serves the canned fixtures with real semantics —
 * follows 3xx Location hops (up to fetch's limit), does not follow 300/304,
 * decodes compressed bodies, and leaves text() pending for a body that never
 * ends. A fetch-based implementation gets plausible responses, so tests fail
 * only on the security/behavior assertions they actually make; the fixed
 * implementation never calls this at all.
 */
function serveOverFetch(url: string, hop = 0): Promise<FetchResponse> {
  if (hop >= FETCH_REDIRECT_LIMIT) {
    return Promise.reject(new Error(`redirect count exceeded at ${url}`));
  }
  const spec = nextSpec();
  const location = spec.headers?.location;
  if (FETCH_REDIRECT_STATUSES.has(spec.status) && location !== undefined) {
    return serveOverFetch(new URL(location, url).toString(), hop + 1);
  }
  return Promise.resolve({
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    statusText: spec.statusText ?? "",
    headers: spec.headers ?? {},
    text: spec.hang
      ? () => new Promise<string>(() => {})
      : () => Promise.resolve(decodeBody(spec)),
  });
}

function captureTool() {
  let tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> };
  const pi = { registerTool: vi.fn((t) => (tool = t)) } as unknown as ExtensionAPI;
  webTool()(pi);
  return { tool: tool!, pi };
}

async function fetchText(
  tool: { execute: (id: string, params: unknown) => Promise<unknown> },
  url: string,
): Promise<string> {
  const result = (await tool.execute("id", { url })) as ToolResult;
  return result.content[0]!.text;
}

/** The address the (mock) connection was told to use, if any. */
let lastConnectedAddress: string | undefined;
/** The headers the implementation sent on the first request. */
let lastRequestHeaders: Record<string, string> | undefined;

/** Makes http(s).request reply with the given responses, in order (the last repeats).
 *  Mirrors the real stack: the connection's lookup is called before responding,
 *  and a lookup error fails the request. */
function stubResponses(list: MockResponse[]) {
  responses = list;
  fetchCalls = 0;
  let call = 0;
  lastConnectedAddress = undefined;
  lastRequestHeaders = undefined;
  const impl = ((
    url: unknown,
    options: { lookup?: ConnectLookup; headers?: Record<string, string> },
    cb: (res: unknown) => void,
  ) => {
    const spec = responses[Math.min(call++, responses.length - 1)] ?? { status: 200 };
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    const respond = (): void => {
      const res = new PassThrough() as PassThrough & {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
      };
      res.statusCode = spec.status;
      res.statusMessage = spec.statusText ?? "";
      res.headers = spec.headers ?? {};
      cb(res);
      if (call === 1) {
        lastRequestHeaders = options.headers;
      }
      if (spec.body !== undefined) {
        res.write(Buffer.from(spec.body));
      }
      if (!spec.hang) {
        res.end();
      }
    };
    req.end = () => {
      const lookup = options.lookup;
      if (lookup === undefined) {
        queueMicrotask(respond);
        return;
      }
      const host = new URL(String(url)).hostname.replace(/^\[/, "").replace(/\]$/, "");
      lookup(host, { all: false, family: 0 }, (err, address) => {
        if (err !== null) {
          queueMicrotask(() => req.emit("error", err));
          return;
        }
        lastConnectedAddress = typeof address === "string" ? address : undefined;
        queueMicrotask(respond);
      });
    };
    return req;
  }) as unknown as typeof httpsRequest;
  vi.mocked(httpsRequest).mockImplementation(impl);
  vi.mocked(httpRequest).mockImplementation(impl);
}

/** Options our implementation passed to the connection request. */
function requestOptions(): { lookup: ConnectLookup } {
  const call = vi.mocked(httpsRequest).mock.calls[0];
  if (call === undefined) {
    throw new Error("no request was made");
  }
  return (call as unknown[])[1] as { lookup: ConnectLookup };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  // Fresh fixtures per test: unstubbbed tests get a benign 200 from the fetch
  // stand-in, never leftovers from a previous test.
  responses = [];
  fetchCalls = 0;
  // A realistic fetch stand-in serving the same fixtures as the HTTP mock:
  // web_fetch must validate hosts itself, so against a fetch-based
  // implementation the security tests fail on their assertions — and the
  // fixed implementation never calls global fetch at all.
  vi.stubGlobal("fetch", vi.fn((input: unknown) => serveOverFetch(String(input))));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("webTool", () => {
  it("registers a web_fetch tool", () => {
    const { tool } = captureTool();
    expect(tool.name).toBe("web_fetch");
  });

  it("fetches an http(s) URL and returns its text", async () => {
    const { tool } = captureTool();
    stubResponses([{ status: 200, body: "hello" }]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    const call = vi.mocked(httpsRequest).mock.calls[0] as unknown[];
    expect(String(call[0])).toBe("https://example.com/x");
    expect(call[1]).toEqual(expect.objectContaining({ lookup: expect.any(Function) }));
    expect(lastRequestHeaders).toEqual(
      expect.objectContaining({ "accept-encoding": "gzip, deflate, br" }),
    );
    expect(text).toBe("hello");
  });

  it("rejects non-http(s) schemes", async () => {
    const { tool } = captureTool();
    const text = await fetchText(tool, "file:///etc/passwd");
    expect(text).toContain("only http/https");
  });

  it("reports a failed fetch", async () => {
    const { tool } = captureTool();
    stubResponses([{ status: 404, statusText: "Not Found" }]);
    const text = await fetchText(tool, "https://example.com/nope");
    expect(text).toContain("404");
  });

  it.each([
    ["loopback", "http://127.0.0.1:9229/json"],
    ["private", "http://10.0.0.1/admin"],
    ["link-local", "http://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "http://[::1]/x"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv6 link-local upper half of fe80::/10", "http://[fea0::1]/"],
    ["IPv6 unique-local", "http://[fd12:3456:789a::1]/"],
    ["IPv4-mapped IPv6", "http://[::ffff:10.0.0.1]/"],
    ["NAT64-mapped IPv4", "http://[64:ff9b::127.0.0.1]/"],
    ["6to4-mapped IPv4", "http://[2002:0a00:1::]/"],
  ])("rejects %s addresses", async (_label: string, url: string) => {
    const { tool } = captureTool();
    const text = await fetchText(tool, url);
    expect(text).toMatch(/^blocked host: /);
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves only to blocked addresses", async () => {
    const { tool } = captureTool();
    lookupMock.mockResolvedValueOnce([{ address: "192.168.1.5", family: 4 }]);
    const text = await fetchText(tool, "http://intranet.corp/wiki");
    expect(text).toBe("blocked host: intranet.corp");
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it("rejects an unresolvable hostname", async () => {
    const { tool } = captureTool();
    lookupMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const text = await fetchText(tool, "https://no-such-host.invalid/x");
    expect(text).toBe("blocked host: no-such-host.invalid");
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it("connects only to the safe address when DNS returns a mixed set", async () => {
    const { tool } = captureTool();
    lookupMock
      .mockResolvedValueOnce([
        { address: "203.0.113.5", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ])
      .mockResolvedValueOnce([
        { address: "203.0.113.5", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ]);
    stubResponses([{ status: 200, body: "hello" }]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(text).toBe("hello");
    expect(lastConnectedAddress).toBe("203.0.113.5");
  });

  it("blocks at connect time when the connection lookup resolves only blocked addresses", async () => {
    const { tool } = captureTool();
    lookupMock
      .mockResolvedValueOnce([{ address: "203.0.113.5", family: 4 }]) // pre-check passes
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]); // connect-time: only blocked
    stubResponses([{ status: 200, body: "leak" }]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(text).toBe("blocked host: example.com");
  });

  it("hands the connection a lookup that returns the validated address", async () => {
    const { tool } = captureTool();
    stubResponses([{ status: 200, body: "hi" }]);
    await fetchText(tool, "https://example.com/x");
    const { lookup } = requestOptions();
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const cb = vi.fn();
    lookup("example.com", { all: false }, cb);
    await tick();
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("rejects at connect time when DNS changes to a blocked address (TOCTOU)", async () => {
    const { tool } = captureTool();
    stubResponses([{ status: 200, body: "leak" }]);
    // Pre-check passed: the mock resolved a public address.
    await fetchText(tool, "https://example.com/x");
    const { lookup } = requestOptions();
    // Now, at connect time, the same name resolves to loopback.
    lookupMock.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const cb = vi.fn();
    lookup("example.com", { all: false }, cb);
    await tick();
    const err = cb.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("blocked host: example.com");
  });

  it.each([
    ["gzip", "gzip", gzipSync],
    ["deflate", "deflate", deflateSync],
    ["brotli", "br", brotliCompressSync],
  ])("decodes %s responses like fetch.text did", async (_label, encoding, compress) => {
    const { tool } = captureTool();
    stubResponses([
      {
        status: 200,
        headers: { "content-encoding": encoding },
        body: compress("hello compressed"),
      },
    ]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(text).toBe("hello compressed");
  });

  it("rejects a redirect to a blocked address and re-checks each hop", async () => {
    const { tool } = captureTool();
    stubResponses([
      { status: 302, statusText: "Found", headers: { location: "http://127.0.0.1:9229/json" } },
    ]);
    const text = await fetchText(tool, "https://example.com/redirect");
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(text).toBe("blocked host: 127.0.0.1");
  });

  it("follows a redirect to an allowed host and returns its text", async () => {
    const { tool } = captureTool();
    stubResponses([
      {
        status: 301,
        statusText: "Moved Permanently",
        headers: { location: "https://other.example.com/y" },
      },
      { status: 200, body: "redirected" },
    ]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(text).toBe("redirected");
  });

  it("follows a redirect as soon as headers arrive, without waiting for the body", async () => {
    const { tool } = captureTool();
    stubResponses([
      {
        status: 302,
        statusText: "Found",
        headers: { location: "https://other.example.com/y" },
        hang: true,
      },
      { status: 200, body: "redirected" },
    ]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(text).toBe("redirected");
  }, 2000);

  it("stops after too many redirects", async () => {
    const { tool } = captureTool();
    stubResponses(
      Array.from({ length: 8 }, (_, i) => ({
        status: 302,
        statusText: "Found",
        headers: { location: `https://example.com/r${i + 1}` },
      })),
    );
    const text = await fetchText(tool, "https://example.com/r0");
    expect(httpsRequest).toHaveBeenCalledTimes(6);
    expect(text).toContain("too many redirects");
  });

  it("does not follow 300 Multiple Choices", async () => {
    const { tool } = captureTool();
    stubResponses([
      {
        status: 300,
        statusText: "Multiple Choices",
        headers: { location: "https://other.example.com/" },
      },
    ]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(text).toContain("fetch failed: 300");
  });

  it("does not follow 304 Not Modified", async () => {
    const { tool } = captureTool();
    stubResponses([{ status: 304, statusText: "Not Modified" }]);
    const text = await fetchText(tool, "https://example.com/x");
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(text).toContain("fetch failed: 304");
  });
});
