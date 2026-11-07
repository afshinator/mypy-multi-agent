/**
 * Peers outlive a killed `run` (#415).
 *
 * A peer is a child of the supervisor's pi. When the CLI dies — Ctrl-C, a closed terminal, a
 * crash — the supervisor exits with it and the peers are left with no owner. They still hold
 * the run's bus socket and keep their pane, and nothing else on the machine removes them.
 *
 * So the driver reaps them by the one string that names this run and nothing else: the
 * `run-details` path, which appears in every peer's command line as its `--config` file.
 */
import { execFile } from "node:child_process";

export type ReapPeers = (runDetails: string) => Promise<boolean>;

type Exec = (args: string[]) => Promise<unknown>;

const defaultExec: Exec = async (args) =>
  new Promise((resolve, reject) => {
    execFile("pkill", args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * `true` when something was killed. pkill exits non-zero when it matched nothing, which is
 * the ordinary case for a clean run, so that is not an error: only a missing pkill is.
 */
export function createReaper(exec: Exec = defaultExec): ReapPeers {
  return async (runDetails) => {
    try {
      await exec(["-f", `${runDetails}/.peer-`]);
      return true;
    } catch {
      return false;
    }
  };
}
