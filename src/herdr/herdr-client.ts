/**
 * Herdr pane-control adapter boundary (interface + real CLI client), so tests
 * can inject a fake herdr.
 */
import { execFile } from "node:child_process";

export interface PaneMetadata {
  state?: string;
  cost?: string;
  tokens?: string;
  role?: string;
  model?: string;
  displayAgent?: string;
  title?: string;
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
    const args = ["pane", "split", opts.paneId ?? "--current", "--direction", opts.direction ?? "right"];
    if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
    args.push("--no-focus");
    if (opts.cwd) args.push("--cwd", opts.cwd);
    const out = await this.exec(args);
    return (JSON.parse(out) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
  }

  async runCommand(paneId: string, command: string): Promise<void> {
    await this.exec(["pane", "run", paneId, command]);
  }

  async reportMetadata(paneId: string, source: string, meta: PaneMetadata): Promise<void> {
    const args = ["pane", "report-metadata", paneId, "--source", source];
    if (meta.state !== undefined) args.push("--token", `state=${meta.state}`);
    if (meta.cost !== undefined) args.push("--token", `cost=${meta.cost}`);
    if (meta.tokens !== undefined) args.push("--token", `tokens=${meta.tokens}`);
    if (meta.role !== undefined) args.push("--token", `role=${meta.role}`);
    if (meta.model !== undefined) args.push("--token", `model=${meta.model}`);
    if (meta.displayAgent !== undefined) args.push("--display-agent", meta.displayAgent);
    if (meta.title !== undefined) args.push("--title", meta.title);
    await this.exec(args);
  }

  async closePane(paneId: string): Promise<void> {
    await this.exec(["pane", "close", paneId]);
  }
}
