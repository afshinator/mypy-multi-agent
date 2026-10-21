import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import { parseServerConfig, resolveWithinRoot } from "./lib/server-config";

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function serverFilesystem(): Plugin {
  return {
    name: "run-inspector-filesystem",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/api/fs/list" && url.pathname !== "/api/fs/read") {
          if (url.pathname === "/api/fs" || url.pathname.startsWith("/api/fs/")) {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
          }
          next();
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }

        let projectsDir: string;
        try {
          const configText = await readFile(
            path.resolve(server.config.root, "inspector.yaml"),
            "utf8",
          );
          projectsDir = path.resolve(
            server.config.root,
            parseServerConfig(configText, homedir()).projectsDir,
          );
        } catch {
          sendJson(response, 500, { error: "inspector.yaml missing or invalid" });
          return;
        }
        const root = await realpath(projectsDir).catch(() => null);
        if (root === null) {
          sendJson(response, 404, { error: "Projects directory not found" });
          return;
        }

        const requestedPath = url.searchParams.get("path") ?? "";
        const containedPath = resolveWithinRoot(root, requestedPath);
        if (containedPath === null) {
          sendJson(response, 403, { error: "Path is outside projects directory" });
          return;
        }
        const target = path.resolve(root, requestedPath);
        if (!isWithinRoot(root, target)) {
          sendJson(response, 403, { error: "Path is outside projects directory" });
          return;
        }

        const realTarget = await realpath(target).catch(() => null);
        if (realTarget === null) {
          sendJson(response, 404, { error: "Path not found" });
          return;
        }
        if (!isWithinRoot(root, realTarget)) {
          sendJson(response, 403, { error: "Path is outside projects directory" });
          return;
        }

        try {
          if (url.pathname === "/api/fs/list") {
            const entries = await readdir(realTarget, { withFileTypes: true });
            sendJson(
              response,
              200,
              entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() })),
            );
            return;
          }
          const [text, details] = await Promise.all([
            readFile(realTarget, "utf8"),
            stat(realTarget),
          ]);
          sendJson(response, 200, { text, mtimeMs: details.mtimeMs });
        } catch {
          sendJson(response, 404, { error: "Unable to read path" });
        }
      });
    },
  };
}
