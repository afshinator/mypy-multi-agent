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
import { questionInPane } from "./progress";

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

    // A blocked pane is what a run cannot answer for itself (#415). Both calls are
    // best-effort: an unreadable pane reports nothing rather than failing the run.
    async paneStatus(paneId) {
      let state: string | undefined;
      try {
        const body = parseJson(await exec(["pane", "get", paneId])) as {
          result?: { pane?: { agent_status?: unknown } };
        };
        const raw = body.result?.pane?.agent_status;
        if (typeof raw === "string") state = raw;
      } catch {
        return undefined;
      }
      if (state === undefined) return undefined;
      if (state !== "blocked") return { state };
      const question = await exec(["pane", "read", paneId])
        .then(questionInPane)
        .catch(() => undefined);
      return question === undefined ? { state } : { state, question };
    },
  };
}
