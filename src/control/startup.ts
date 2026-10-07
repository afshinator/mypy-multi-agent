/**
 * Pre-spawn config parse plus bus start. Failure here exits 3 before any peer
 * process exists.
 */
import { EXIT, type ExitCode } from "../runtime/exit";

export type StartupResult = { ok: true } | { ok: false; exitCode: ExitCode };

export async function runStartup(deps: {
  parseConfig: () => unknown;
  startBus: () => Promise<void>;
}): Promise<StartupResult> {
  try {
    deps.parseConfig();
    await deps.startBus();
    return { ok: true };
  } catch {
    return { ok: false, exitCode: EXIT.CONFIG_ERROR };
  }
}
