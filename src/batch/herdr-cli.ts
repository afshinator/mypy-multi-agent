/**
 * The real `herdr` implementation of the executor's seam.
 *
 * Two shapes were measured rather than assumed: `workspace create` returns
 * `result.workspace.workspace_id` and `result.root_pane.pane_id`, and `workspace get`
 * **exits 0** for a workspace that is gone, answering `{"error":{"code":"workspace_not_found"}}`.
 * That is why liveness is read from the body and never from the exit status.
 */
import { execFile } from "node:child_process";
import type { Herdr } from "./executor";

export type Exec = (args: string[]) => Promise<string>;

const defaultExec: Exec = (args) =>
  new Promise((resolve, reject) => {
    execFile("herdr", args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

interface Envelope {
  result?: {
    workspace?: { workspace_id?: string };
    root_pane?: { pane_id?: string };
  };
  error?: { code?: string };
}

function parseJson(text: string): Envelope {
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    throw new Error(`herdr returned non-JSON: ${text.trim().slice(0, 200)}`);
  }
}

export function createHerdr(exec: Exec = defaultExec): Herdr {
  return {
    async createWorkspace({ cwd, label }) {
      const body = parseJson(
        await exec(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]),
      );
      const workspaceId = body.result?.workspace?.workspace_id;
      const paneId = body.result?.root_pane?.pane_id;
      if (workspaceId === undefined || paneId === undefined) {
        throw new Error("herdr workspace create returned no workspace_id/pane_id");
      }
      return { workspaceId, paneId };
    },

    async runInPane(paneId, command) {
      await exec(["pane", "run", paneId, command]);
    },

    async workspaceExists(workspaceId) {
      let body: Envelope;
      try {
        body = parseJson(await exec(["workspace", "get", workspaceId]));
      } catch {
        // A CLI hiccup is not evidence of a closed workspace; the run's timeout bounds it.
        return true;
      }
      return body.error?.code !== "workspace_not_found";
    },

    async closeWorkspace(workspaceId) {
      // Closing an already-closed workspace is not an error worth failing a batch over.
      await exec(["workspace", "close", workspaceId]).catch(() => "");
    },
  };
}
