/**
 * User-abort flow: graceful stop, bounded grace, force-kill, teardown,
 * aborted final.md, exit 2.
 */
import { EXIT, type ExitCode } from "../runtime/exit";
import type { Finalization } from "../supervisor/finalization";
import type { ControlPlane } from "./control-plane";

export interface AbortDeps {
  controlPlane: ControlPlane;
  launcher: { terminateAll(): Promise<void> };
  bus: { stop(): Promise<void> };
  finalWriter: { write(f: Finalization): Promise<void> };
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ABORTED_DECISION = "Run aborted by the user before the supervisor finalized a decision.";

export async function abortSession(deps: AbortDeps): Promise<ExitCode> {
  deps.controlPlane.stopAll("user abort");
  await (deps.sleep ?? defaultSleep)(deps.graceMs ?? 10_000);
  deps.controlPlane.killAll("user abort");
  // Teardown failures must not skip the bus stop or the artifact: the aborted
  // final.md is the abort's product, and a live socket blocks the next run.
  let teardown: unknown;
  try {
    await deps.launcher.terminateAll();
  } catch (err) {
    teardown = err;
  }
  try {
    await deps.bus.stop();
  } catch (err) {
    teardown ??= err;
  }
  const reason = teardown instanceof Error ? teardown.message : String(teardown);
  await deps.finalWriter.write({
    outcome: "aborted",
    exitCode: EXIT.USER_ABORTED,
    reports: [],
    decision:
      teardown === undefined
        ? ABORTED_DECISION
        : `${ABORTED_DECISION} Teardown failed (${reason}); peers may still be running.`,
  });
  return EXIT.USER_ABORTED;
}
