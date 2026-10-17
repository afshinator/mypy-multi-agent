/**
 * pi extension registering web_fetch, giving a peer web research without
 * granting shell.
 */

import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;
/** The only response codes that are redirects worth following. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isBlockedIpv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Expands an IPv6 address into its 8 hextets, or null if malformed. */
function expandV6(v6: string): number[] | null {
  const parts = v6.split("::");
  if (parts.length > 2) {
    return null;
  }
  const head = (parts[0] ?? "").split(":").filter((h) => h !== "");
  const tail = (parts[1] ?? "").split(":").filter((h) => h !== "");
  const fill = 8 - head.length - tail.length;
  if (fill < 0) {
    return null;
  }
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((h) =>
    Number.parseInt(h, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

/** The IPv4 address two hextets encode. */
const v4FromHextets = (hi: number, lo: number): string =>
  `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** Loopback, private, link-local, CGNAT, non-routable, and zone-scoped addresses are off-limits. */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isBlockedIpv4(ip);
  }
  if (family !== 6) {
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6.includes("%")) {
    return true; // zone id, e.g. fe80::1%eth0
  }
  // Trailing dotted quad: IPv4-compatible, IPv4-mapped, and NAT64 forms.
  const quad = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  if (quad?.[1] !== undefined && isBlockedIpv4(quad[1])) {
    return true;
  }
  const groups = expandV6(v6);
  if (groups === null) {
    return false;
  }
  const first = groups[0] ?? 0;
  if (first === 0) {
    return true; // ::, ::1, and the IPv4-compatible/mapped space
  }
  if (first === 0x64 && groups[1] === 0xff9b) {
    return isBlockedIpv4(v4FromHextets(groups[6] ?? 0, groups[7] ?? 0)); // NAT64 embeds an IPv4 address
  }
  if (first === 0x2002) {
    return isBlockedIpv4(v4FromHextets(groups[1] ?? 0, groups[2] ?? 0)); // 6to4 embeds an IPv4 address
  }
  return (
    (first >= 0xfe80 && first <= 0xfebf) || // link-local
    (first >= 0xfc00 && first <= 0xfdff) || // unique local
    first >= 0xff00 // multicast
  );
}

/** URL.hostname keeps the brackets on IPv6 literals; strip them before validating. */
function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** True when the host is unsafe: it resolves to no unblocked address, or does not resolve. */
async function isBlockedHost(hostname: string): Promise<boolean> {
  try {
    const addresses = await dnsLookup(bareHostname(hostname), { all: true });
    return !addresses.some((r) => !isBlockedIp(r.address));
  } catch {
    return true;
  }
}

/**
 * The lookup handed to http(s).request: the connection uses exactly the address
 * returned here, so a host that resolves to a blocked address — even only at
 * connect time — never gets connected to.
 */
function safeLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  void dnsLookup(hostname, { all: true, family: options.family })
    .then((addresses) => {
      const allowed = addresses.filter((r) => !isBlockedIp(r.address));
      const first = allowed[0];
      if (first === undefined) {
        callback(new Error(`blocked host: ${hostname}`), "");
        return;
      }
      if (options.all === true) {
        callback(null, allowed);
      } else {
        callback(null, first.address, first.family);
      }
    })
    .catch((err: unknown) => {
      callback(err instanceof Error ? err : new Error(String(err)), "");
    });
}

interface FetchResult {
  status: number;
  statusText: string;
  headers: IncomingMessage["headers"];
  text: () => Promise<string>;
}

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Collects a stream into the response, decoding it like fetch.text would. */
function finishResponse(
  res: IncomingMessage,
  stream: Readable,
  resolve: (result: FetchResult) => void,
  reject: (err: Error) => void,
): void {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("error", reject);
  stream.on("end", () => {
    resolve({
      status: res.statusCode ?? 0,
      statusText: res.statusMessage ?? "",
      headers: res.headers,
      text: () => Promise.resolve(Buffer.concat(chunks).toString("utf8")),
    });
  });
}

function requestUrl(url: URL, signal: AbortSignal): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      headers: { "user-agent": "pi-peer/1.0", "accept-encoding": "gzip, deflate, br" },
      lookup: safeLookup as unknown as LookupFunction,
      signal,
    };
    const onResponse = (res: IncomingMessage): void => {
      res.on("error", reject);
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        // Follow as soon as headers arrive; drain the body without waiting for it.
        res.resume();
        resolve({
          status,
          statusText: res.statusMessage ?? "",
          headers: res.headers,
          text: () => Promise.resolve(""),
        });
        return;
      }
      const encoding = String(headerValue(res.headers, "content-encoding") ?? "").toLowerCase();
      if (encoding === "gzip") {
        finishResponse(res, res.pipe(createGunzip()), resolve, reject);
      } else if (encoding === "deflate") {
        finishResponse(res, res.pipe(createInflate()), resolve, reject);
      } else if (encoding === "br") {
        finishResponse(res, res.pipe(createBrotliDecompress()), resolve, reject);
      } else {
        finishResponse(res, res, resolve, reject);
      }
    };
    let req: ClientRequest;
    if (url.protocol === "https:") {
      req = httpsRequest(url, options, onResponse);
    } else {
      req = httpRequest(url, options, onResponse);
    }
    req.on("error", reject);
    req.end();
  });
}

export function webTool(): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "web_fetch",
      label: "Web fetch",
      description:
        "Fetch a URL and return its text (truncated). For web research; use http/https URLs.",
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
          return {
            content: [{ type: "text", text: "only http/https URLs are allowed" }],
            details: undefined,
          };
        }
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return {
              content: [{ type: "text", text: "only http/https URLs are allowed" }],
              details: undefined,
            };
          }
          if (await isBlockedHost(parsed.hostname)) {
            return {
              content: [{ type: "text", text: `blocked host: ${bareHostname(parsed.hostname)}` }],
              details: undefined,
            };
          }
          let res: FetchResult;
          try {
            res = await requestUrl(parsed, AbortSignal.timeout(30_000));
          } catch (err) {
            const message = err instanceof Error ? err.message : "";
            if (message.startsWith("blocked host:")) {
              return { content: [{ type: "text", text: message }], details: undefined };
            }
            return {
              content: [{ type: "text", text: "fetch failed: timed out after 30s" }],
              details: undefined,
            };
          }
          if (REDIRECT_STATUSES.has(res.status)) {
            const location = headerValue(res.headers, "location");
            if (location === undefined) {
              return {
                content: [{ type: "text", text: `fetch failed: ${res.status} ${res.statusText}` }],
                details: undefined,
              };
            }
            try {
              parsed = new URL(location, parsed);
            } catch {
              return {
                content: [{ type: "text", text: `invalid redirect url: ${location}` }],
                details: undefined,
              };
            }
            continue;
          }
          if (res.status < 200 || res.status >= 300) {
            return {
              content: [{ type: "text", text: `fetch failed: ${res.status} ${res.statusText}` }],
              details: undefined,
            };
          }
          const text = await res.text();
          const truncated =
            text.length > MAX_CHARS
              ? `${text.slice(0, MAX_CHARS)}\n…[truncated ${text.length - MAX_CHARS} chars]`
              : text;
          return { content: [{ type: "text", text: truncated }], details: undefined };
        }
        return {
          content: [{ type: "text", text: `fetch failed: too many redirects (>${MAX_REDIRECTS})` }],
          details: undefined,
        };
      },
    });
  };
}
