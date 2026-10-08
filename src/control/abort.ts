/**
 * User-abort flow: graceful stop, bounded grace, force-kill, teardown,
 * aborted final.md, exit 2.
 */
import { EXIT, type ExitCode } from "../runtime/exit";
import type { Finalization } from "../supervisor/finalization";
import type { ControlPlane } from "./control-plane";

export interface AbortDeps {
  controlPlane: ControlPlane;
  paneManager: { terminateAll(): Promise<void> };
  bus: { stop(): Promise<void> };
  finalWriter: { write(f: Finalization): Promise<void> };
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function abortSession(deps: AbortDeps): Promise<ExitCode> {
  deps.controlPlane.stopAll("user abort");
  await (deps.sleep ?? defaultSleep)(deps.graceMs ?? 10_000);
  deps.controlPlane.killAll("user abort");
  await deps.paneManager.terminateAll();
  await deps.bus.stop();
  await deps.finalWriter.write({
    outcome: "aborted",
    exitCode: EXIT.USER_ABORTED,
    reports: [],
    decision: "Run aborted by the user before the supervisor finalized a decision.",
  });
  return EXIT.USER_ABORTED;
}
