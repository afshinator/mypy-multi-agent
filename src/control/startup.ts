import { EXIT, type ExitCode } from "../runtime/exit";

export type StartupResult = { ok: true } | { ok: false; exitCode: ExitCode };

/**
 * Config validation and bus startup happen before any peer is spawned, so a
 * failure here leaves no peer processes behind and exits with code 3.
 */
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
