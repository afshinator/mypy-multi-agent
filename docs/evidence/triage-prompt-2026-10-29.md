# Evidence: the issue-to-DoD triage prompt, 2026-10-29

**Question.** Can one agent with no context turn an unverified GitHub issue into a
Definition of Done (DoD) that a later session can execute — and refuse when the issue
cannot support one?

**Method.** Two tests. Each one fresh agent, its own context, read-only tools, no run,
no peers, no panes. The agent received one issue number and the prompt; it received no
conversation, no conclusions from earlier sessions, and no hint about which claim, if
any, was wrong. The judge re-checked the load-bearing claims by hand after each test.

|                         | Test 1 — issue #135                                                                                                                                                    | Test 2 — issue #132                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prompt                  | four-step protocol plus a warning that tickets here assert false things                                                                                                | the same protocol, warning removed                                                                                                                                          |
| cost                    | 36 turns, ~100k tokens                                                                                                                                                 | 21 turns, ~87k tokens                                                                                                                                                       |
| found                   | the blamed mechanism was off the failing path: 0 `RESUMED` events in the cited log, and the briefing renders only in the `--resume` branch (`src/pi/extension.ts:264`) | a false count (two full-suite runs, not three) and a fix that cannot work (`tool-permissions.ts:22` exact match, `:21` edit bypass, `session-schema.ts:179` read-only only) |
| wrong in its own output | reported 1043 tests where the suite runs 1037; cited `restartAgent` at the wrong line                                                                                  | left one premise unverified (that the run's prompt already forbade full-suite runs)                                                                                         |

**What this fixed.** The warning is unnecessary: the protocol's step 1 and step 3
produced both findings without being told that anything was wrong. Test two cost less
than test one and found more. The warning was removed, and the prompt is now the
protocol plus the slots in `docs/triage-prompt.md`.

**What it exposed.** Asked to write a DoD, test two hit a fix that could not work — and
repaired it instead. It dropped the broken clause, added the machinery needed to make
the rest work, and wrote five criteria for that repaired change, returning `run`. Its
`Fix` section said the proposal does not reach the mechanism, so it was not silent; the
abort branch lost to the urge to be useful. This is why step 4 carries the explicit
no-repair clause: "can a DoD be written" is always yes, because a capable agent can
always invent a different change.

**What it does not show.**
- Nothing about implementation quality. Neither test wrote code.
- Not independence of model: both tests ran on the same model as the session that
  wrote the prompt.
- The refusal is partly prompted. The N1–N5 list names the failure shapes, and N2
  describes the shape test two's headline finding took. The claim checks were
  unprompted; the refusal judgement was not fully.
- Both tests produced at least one wrong claim of their own, so the judge step is not
  optional.

Related: issues #132 and #135, and the prompt itself in `docs/triage-prompt.md`.
