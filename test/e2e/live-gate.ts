/**
 * Gate for the live end-to-end suite. It must be explicit: peers and their bash
 * tools inherit HERDR_ENV=1 from the pane they run in, and a suite that switched
 * itself on because it detected a pane nested a real run inside a real run.
 */
export function e2eEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.E2E_LIVE === "1";
}
