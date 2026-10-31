# TokenEconomizer on Pi — evaluation, install, verification

Status: **installed and verified working on pi 1.4.0** (upstream tests only 1.2.0–1.3.0).
Config: **micro-skills off, tool pruning off, loop guard on (`nudge`)**.

## What it is

Microsoft Research plugin: "experience-driven black-box cost control for coding agents"
(Apache-2.0, Python 3.10+). Three mechanisms:
- **Micro-skills** — inject facts remembered from past sessions in a repo.
- **Tool pruning** — stop loading tools that go unused.
- **Failure-loop guard** — a judge model detects a stuck turn and redirects it once.

## Verdict

Do not adopt as a whole. In this harness:
- **Tool pruning is a no-op** on Pi (Pi loads four tools; README: "Pi | nothing").
- **Micro-skills duplicates** pi's native skills plus this repo's `AGENTS.md`/`.agents/skills`/`GLOSSARY.md`.
- **Only the loop guard is additive** — it targets the agent's _own_ turn looping, which this
  repo's stall/timeout machinery does not cover (that covers _peer_ sessions).

So: loop guard on, the other two off.

## Compatibility (verified, not assumed)

- Upstream's supported Pi range is 1.2.0–1.3.0; this machine runs **1.4.0**.
- Verified the extension's full API surface exists in the installed 1.4.0 types:
  `sendMessage(..., { deliverAs: "steer" })`, `on("session_start" | "before_agent_start" |
  "agent_end" | "session_shutdown" | "tool_result")`, `registerCommand`,
  `systemPromptOptions.sections`, `structuredContent`, `isError`, `getSessionId`/`getSessionFile`/
  `getBranch`, `mode`, `hasUI`.
- **Live load test passed**: a headless `pi -p` session loaded the extension, folded the
  session, and `te status` recorded it (`1 folded, 1.6k effective tokens, plugin overhead 0`).
  No `errors.log`.

## Blocker: Python 3.10+ (do not skip)

- System `python3` is **3.9.6**; the plugin needs ≥3.10.
- `te doctor` without the fix: `TokenEconomizer needs Python >= 3.10 (this is 3.9.6); set TE_PYTHON`.
- Fix: `TE_PYTHON=/opt/homebrew/bin/python3.14` (Homebrew Python 3.14.8).
- **Applied durably** (2026-10-31): `export TE_PYTHON=/opt/homebrew/bin/python3.14` is now in
  `~/.zshenv` and `~/.zshrc`. New herdr panes and pi sessions get it automatically — no
  herdr-server restart (verified: a fresh pane resolved it to Python 3.14.8). Already-running
  panes keep their pre-edit env until recreated.

## Install + setup (done)

```sh
pi install git:github.com/microsoft/TokenEconomizer
pi list   # shows: git:github.com/microsoft/TokenEconomizer
```

Clone lives at `~/.pi/agent/git/github.com/microsoft/TokenEconomizer`; after the first session a
launcher appears at `~/.tokeneconomizer/bin/te`.

## Config (done, persistent per-repo)

```sh
TE_PYTHON=/opt/homebrew/bin/python3.14 \
  ~/.pi/agent/git/github.com/microsoft/TokenEconomizer/plugin/scripts/te --host pi \
  config set microskills=off toolprune=off
```

`status` confirms: `config microskills=off toolprune=off loopguard=nudge repomap=off`.

## What to look for (measurement)

### Level 1 — confirm the guard fires (smoke test; load/fold already verified)

1. **Warm the envelope.** The guard is inert until `loopguard.envelope_min_samples` (5) turns
   have "ended well" (on their own, no failing check after the last edit). Run 5 clean turns, or
   for a smoke test only, lower it: `config set loopguard.envelope_min_samples=1`.
2. **Run a loop-inducing turn** — a task that repeats the same failing check/edit.
3. **Look for:**
   - `status` → `plugin overhead` > 0 (the judge call happened, and its cost is billed to the
     same provider/model).
   - a redirect delivered as a steering message in the session.
   - after `loopguard_nudges` (1) redirects, a one-line "still stuck" notice.

### Level 2 — measure cost (A/B only; a single task proves nothing)

The guard has a nonzero cost (the judge runs as a headless `pi -p` on your own model) and only
acts on looping turns, so one task cannot show net savings.
- **Control vs intervention**: `config set shadow=true` = decide and log everything, act on
  nothing (judge still runs, no redirect) — a clean baseline. `shadow=false` = real intervention.
- Run the same real tasks in both modes; compare `status` → `X effective tokens + plugin
  overhead Y (Z%)`. Savings = the token delta on looping turns minus the judge overhead.
- Small N is noise (the paper used 277 tasks × 6 repos for its 18–30% claim). Better: run real
  work with the guard on and compare against this repo's own per-session cost telemetry
  (scorecard collector, accounting, `final.md` budgets).

## Results to expect over N runs — and how to spot them

One command reads everything: `~/.tokeneconomizer/bin/te --host pi status` (from a terminal,
free; `/te status` in-session costs one model turn). The plugin records values passively — no
export or trigger is needed, and nothing is pushed to you.

Timeline (loop guard is the only active mechanism here):

| runs                         | `status` shows                                                | meaning                                    |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| 1–4                          | `loopguard envelope not learned yet (0..4 ended-green turns)` | guard inert by design; `plugin overhead 0` |
| ≥5 well-ended turns          | `envelope learned (N ended-green turns)`                      | guard armed                                |
| a looping turn, after arming | `plugin overhead > 0`; `+1 redirect` or `+1 still-stuck`      | judge ran and intervened                   |

Read these two lines in `status`:
- `sessions N folded, X effective tokens, plugin overhead Y (Z%)` — the cost accounting: `X` =
  session tokens, `Y` = what the judge/proposer cost, `Z%` = overhead share.
- `loopguard envelope ...; M redirect(s), K still-stuck notice(s) over T turns` — the
  intervention tally.

What counts as working:
- `M redirects > 0` and `K still-stuck = 0` → redirects are recovering turns (the win).
- `K > 0` → a turn stayed stuck after its redirect; the guard printed a stop hint, and you must
  stop it (it never stops a turn itself).
- `Y` growing with no `M` → the judge is being asked but finding nothing stuck, or turns recover
  on their own — overhead without benefit.

What the tool does **not** report: a "$ saved" number. Savings are inferred: tokens not burned
on stuck turns (vs a `shadow=true` or historical baseline) minus the `Y` overhead.

**Action required vs autonomous.** Envelope learning, judging, redirecting, and all value
recording happen on their own during turns. Two things need you: (1) read `status` — results
are never pushed; (2) act on a "still stuck" notice to stop the turn (Esc interactive / Ctrl+C
headless). The disabled mechanisms need nothing: `microskills` stays `0 fact(s)`, `toolprune`
shows `not available on this host`.

## Gotchas

- **`TE_PYTHON` is profile-provided** — already-running panes/sessions won't re-source the
  profile; recreate them (a fresh `mypi-run`) to pick it up. A bare `te`/`pi` from a non-zsh
  shell still needs it set manually.
- **Judge needs `pi -p` headless** signed in with the current provider; if it is not, the guard
  degrades to backstop-only and a line lands in `~/.tokeneconomizer/errors.log`.
- **The guard never stops a turn.** It nudges once, then prints "still stuck" and leaves the
  stop to you.
- **`loopguard.envelope_min_samples` = 5** is the make-or-break: forget the warm-up and the guard
  never fires, which reads as "broken".
- **`paid_model`** defaults to the agent's own model on Pi (deepseek here), so judge calls ride
  the same plan.
