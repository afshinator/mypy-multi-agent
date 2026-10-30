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

**Untested changes, recorded so they are not mistaken for measured wins.** The prompt was
revised twice after the tests, and neither revision has been exercised:
1. The objective became an investigation with one conditional output, not "produce a DoD".
   The reason is the repair above: an agent whose objective is a DoD will produce one.
2. The path vocabulary went. Numbered steps with plain instructions replaced `PATH n` and
   `EXIT STOP`; "the reply ends there" replaced the prohibitions. The only rule kept from
   that draft is that a blocked DoD is reported rather than worked around.
3. Step 5 checks the DoD against six defect classes, each taken from a ticket in this repo:
   vacuous (`17-lock-protocol`'s contradictory pair cost two attestation rounds), partial
   (#132 asked for two changes and covered one), unverifiable by construction (the "a later
   session's log shows …" clause in #126/#128), off-surface, off-ask, and already true.

4. Two §10 conformance gaps found by review were closed. The agent is `shell: true,
   edit: false` with no allowlist — §10's own anti-pattern — so "read-only" was an
   instruction, not a capability; it now runs in a disposable clone (`cp -Rc`), which makes
   the limit real. And step 5 could order a spending command to test a criterion, so it now
   runs only checks that are read-only and cheap.

Tests A-D in `docs/triage-prompt.md` are what would move these from stated rationale to
evidence.

## Results: nine runs, and what each one proved

| run | subject         | verdict                                  | judge's check (by hand)                                                                                                                                                    |
| --- | --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | #135            | mechanism off the failing path           | confirmed: 0 `RESUMED` events, briefing is `--resume`-only                                                                                                                 |
| 2   | #132            | repaired a broken fix and returned `run` | confirmed: the fix cannot work (`tool-permissions.ts:21,22`)                                                                                                               |
| 3   | #138            | `No DoD: N2` (fix is upstream)           | confirmed: `edit-diff.js:184/233`, and the wrong citation `:90` -> `:117`                                                                                                  |
| 4   | #125            | `No DoD: N1` (criterion unfalsifiable)   | confirmed: `details` is unread; the 30% premise is a measurement artifact                                                                                                  |
| 5   | #107            | `No DoD: N5` (already done)              | confirmed: `2420523` is an ancestor of HEAD and touches only `justfile`                                                                                                    |
| 6   | #117            | `No DoD: N5` (already done)              | confirmed: pins, manifest entries, parsers, 10 tools in `toolchain.json`                                                                                                   |
| 7   | #139            | **a DoD** (6 criteria, `inline`)         | need confirmed: neither doc names `baseCommit` or `lock-frames.jsonl`                                                                                                      |
| 8   | #138, rewritten | `No DoD: N2`, same routing question      | reproduced independently on the amended body                                                                                                                               |
| 9   | #125, rewritten | `No DoD: N2`                             | **falsified part of the rewrite**: the notice is 200 B and self-instructs the fetch (`format.ts:276,289`), so 4 of 5 `subagent_result` calls are first reads, not re-reads |

Runs 1-2 used the earlier prompt; 3-9 used the current one, each in its own disposable
clone. Cost: 199 turns and roughly 600k tokens across nine subjects; no run, no pane, no
peer.

**What the nine runs establish.**
- **The investigation works.** Every stop carried commands; none was fabricated. The judge
  confirmed the load-bearing row in each of the nine.
- **The false stop does not occur.** Subjects 3, 5, 6, 7 and 8 recorded between three and
  five `partial` verdicts each (stale line numbers, moved symbols, wrong counts) and carried
  on to a verdict, exactly as step 1 instructs.
- **The healthy path works.** Run 7 produced a numbered DoD, self-checked it, and admitted
  that one of its own criteria was vacuous on today's tree — and it chose `inline` for a
  two-file docs change rather than asking for a run.
- **Triage output must itself be verified.** Runs 8 and 9 were aimed at bodies written by
  the session that wrote the prompt. Run 9 falsified part of its subject; run 7 corrected two
  citations. That is the loop's second-order hazard: a triage report is a claim like any
  other, and the only thing standing behind it is the same protocol.

**Not yet done.** Variant D (no N-codes) is untested, and no subject has yet been a _new_
issue with an unmet need that nobody has rewritten — run 7's DoD was produced against a body
this session authored.

Related: issues #132 and #135, and the prompt itself in `docs/triage-prompt.md`.
