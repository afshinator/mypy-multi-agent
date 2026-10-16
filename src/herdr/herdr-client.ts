/**
 * Herdr pane-control adapter boundary (interface + real CLI client), so tests
 * can inject a fake herdr.
 */
import { execFile } from "node:child_process";

export interface PaneMetadata {
  title?: string;
  /** Structured status tokens (`state`, `role`, `model`, `tokens`, `cost`, `progress`). */
  tokens?: Record<string, string>;
}

export interface CreatePaneOpts {
  direction?: "right" | "down";
  cwd?: string;
  /** Target pane to split. Omit to split the calling pane (--current). */
  paneId?: string;
  /** Fraction of the target pane's extent it retains after the split (0..1). */
  ratio?: number;
}

export interface HerdrClient {
  createPane(opts?: CreatePaneOpts): Promise<string>;
  runCommand(paneId: string, command: string): Promise<void>;
  reportMetadata(paneId: string, source: string, meta: PaneMetadata): Promise<void>;
  closePane(paneId: string): Promise<void>;
}

export type Exec = (args: string[]) => Promise<string>;

const defaultExec: Exec = (args) =>
  new Promise((resolve, reject) => {
    execFile("herdr", args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** Real client: shells out to the `herdr` CLI. `exec` is injectable for tests. */
export class HerdrCliClient implements HerdrClient {
  constructor(private readonly exec: Exec = defaultExec) {}

  async createPane(opts: CreatePaneOpts = {}): Promise<string> {
    const args = [
      "pane",
      "split",
      opts.paneId ?? "--current",
      "--direction",
      opts.direction ?? "right",
    ];
    if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
    args.push("--no-focus");
    if (opts.cwd) args.push("--cwd", opts.cwd);
    // Panes inherit the herdr server's TERM_SESSION_ID, so macOS zsh runs
    // Apple Terminal's session restore and prints "Restored session: ..." (and
    // sources the stale session file) at every pane start. These are agent
    // panes, not Terminal windows, so disable that restore.
    args.push("--env", "SHELL_SESSIONS_DISABLE=1");
    const out = await this.exec(args);
    return (JSON.parse(out) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
  }

  async runCommand(paneId: string, command: string): Promise<void> {
    await this.exec(["pane", "run", paneId, command]);
  }

  async reportMetadata(paneId: string, source: string, meta: PaneMetadata): Promise<void> {
    const args = ["pane", "report-metadata", paneId, "--source", source];
    if (meta.title !== undefined) args.push("--title", meta.title);
    const tokens = meta.tokens ?? {};
    // Sorted so the argv is deterministic regardless of property insertion order.
    for (const name of Object.keys(tokens).sort()) {
      const value = tokens[name];
      // A caller can leave a token value undefined; skip it rather than exit with
      // `name=undefined` and have herdr render a bogus token.
      if (value !== undefined) args.push("--token", `${name}=${value}`);
    }
    await this.exec(args);
  }

  async closePane(paneId: string): Promise<void> {
    await this.exec(["pane", "close", paneId]);
  }
}
