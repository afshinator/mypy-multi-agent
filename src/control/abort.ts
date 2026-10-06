import { EXIT, type ExitCode } from "../runtime/exit";
import type { ControlPlane } from "./control-plane";
import type { Finalization } from "../supervisor/finalization";

export interface AbortDeps {
  controlPlane: ControlPlane;
  paneManager: { terminateAll(): Promise<void> };
  bus: { stop(): Promise<void> };
  finalWriter: { write(f: Finalization): Promise<void> };
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * User abort: graceful stop, bounded grace, force-kill, teardown, aborted
 * artifact, exit 2. Uses only the shared exit-code authority.
 */
export async function abortSession(deps: AbortDeps): Promise<ExitCode> {
  deps.controlPlane.stopAll("user abort");
  await (deps.sleep ?? defaultSleep)(deps.graceMs ?? 10_000);
  deps.controlPlane.killAll("user abort");
  await deps.paneManager.terminateAll();
  await deps.bus.stop();
  await deps.finalWriter.write({ outcome: "aborted", exitCode: EXIT.USER_ABORTED, reports: [] });
  return EXIT.USER_ABORTED;
}
