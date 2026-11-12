# State of the repo — batch driver

Verified 2026-11-12 19:38 UTC against `origin/main` = `d8c497e`. Every claim below was produced by
running the command shown, or by reading the file:line cited. Where a claim could not be verified it
says so instead of being softened. Commands are re-runnable as written; paths are relative to the
repo root unless noted.

## 0. Where this stands

- `origin/main` = `d0a015e` (PR #553). The gate's own command exits 0 inside the run's sandbox —
  measured, §9.6.
- `#541`'s fix is verified against its DoD but **uncommitted** in
  `~/Documents/dev/ma-wt-0026-t541-t541` (§6).
- `0026` failed the gate on two terms, `validation` and `stale-attestation` (§3). The first is closed
  by measurement; the second is untouched.
- No batch run has executed since `d0a015e`.
- Next: one batch run against `main`. It is the first execution of this green gate inside a real peer
  process, so it is the only step that can turn §9.6's measurement into a completed run. The last run
  cost `costUsd: 0.61` (`mypi-tasks/000-batches/0026-t541/tickets/541/run.json`).
- Everything that is not measured is listed in §8. Every other section is a command that was run or a
  file:line that was read.

## 1. Repository state

| Fact                                                                                                                                 | Proof                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `origin/main` = `d0a015e`; the local `main` branch still sits at `d8c497e`                                                           | `git rev-parse origin/main main`                 |
| `04f3514` ("status --wait narrates the live run from its bus transcript") is unlanded: contained only in `task/status-narrates-live` | `git branch --contains 04f3514` (one branch)     |
| `04f3514` touches `src/batch/cli.ts` (+20) and `test/unit/batch-cli.test.ts` (+33)                                                   | `git show --stat 04f3514`                        |
| `mypi-batch.yaml:21` is `triage_model: commandcode/deepseek/deepseek-v4-pro`; `:22` is `verifier_model: commandcode/gpt-6-luna`      | `sed -n '21,22p' mypi-batch.yaml`                |
| `just land` exists                                                                                                                   | `Justfile:116`                                   |
| The three test files of §9.6 are landed                                                                                              | `git log --oneline -1 origin/main` → `d0a015e`   |
| Batch records under `mypi-tasks/000-batches/` are untracked                                                                          | `git status --porcelain mypi-tasks` (18 entries) |

## 2. `#541` ledger (14 batch records, `0013`–`0026`)

| Fact                                                                                                                                                                                                  | Proof                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **15 prepare attempts** across 14 records (`0025` has 2)                                                                                                                                              | `ls -d mypi-tasks/000-batches/00*t541*/tickets/541/attempts/*/ \| wc -l` → 15                                                                      |
| **4 accepted prepares**: `0018`, `0019`, `0025`, `0026`                                                                                                                                               | those four hold `tickets/541/acceptance.json`; every other record holds `refusal.json`, except `0022`, which holds only `attempts/1/identity.json` |
| **4 run records**: `0018`, `0019`, `0025` are `code: "startup-failed"`, 2 attempts, ~128 s each; `0026` is `code: "failure"`, `exitCode: 1`, `durationMs: 943287`, `costUsd: 0.61`, `sandboxed: true` | `tickets/541/run.json` in each                                                                                                                     |
| Prepare spend is **$0.7105** unique. Each attempt's cost is written twice (`attempts/N/decision.json` and `refusal.json`/`acceptance.json`), so summing every JSON double-counts                      | `grep costUsd` over the records yields 27 entries, all paired                                                                                      |
| `0026` run spend **$0.61**; total `#541` spend **≈ $1.32**                                                                                                                                            | `run.json` + the unique prepare sum                                                                                                                |

## 3. Why `0026` failed

### 3.1 Validation

`spans.jsonl` records `validation.command` → `{"command":"bun run check"}`, 11 934 ms, and the gate
logged `term: "validation"`. The command fails in the environment a batch run creates.

Reproduced offline, in `0026`'s worktree:

```
MYPY_UNATTENDED=1 MYPY_NO_SANDBOX=1 bun run test
  → 11 failed | 1829 passed
     test/scripts/write-guard.test.ts  ×10
     test/unit/batch-sandbox.test.ts    ×1
```

Causes, all read from code:
- `scripts/write-guard.ts:260` — `if (process.env.MYPY_UNATTENDED === "1") return;`. The guard
  deliberately stands down when nobody can answer (#415 in the comment), so its tests assert a mode
  the batch never runs in. Ten tests flip with the variable; without it they pass.
- `test/unit/batch-sandbox.test.ts` — "reports availability from the filesystem, not from the
  platform guess" fails when `MYPY_NO_SANDBOX=1` (`expected false to be true`).
- Sandboxed runs add `test/integration/batch-run-sandbox.test.ts` failures: `HOME_ROOT =
  "/Users/Shared"` (`:19`) and `mkdtempSync` there is denied —
  `sandbox-exec -p '<profile>' mkdir -p /Users/Shared/mypi-probe` →
  `mkdir: /Users/Shared/mypi-probe: Operation not permitted`.

With the sandbox left on the suite has **10** failures (write-guard only). Turning the sandbox off by
default makes it **11**, because the availability test then fails. Any change of that default must
update that test in the same commit.

### 3.2 `stale-attestation`

`staleCitations` (`src/supervisor/finalization.ts:243-265`) marks a cited path stale when either
`mtime > attestedAt` (branch 1, `:257`) or `mtime > readAt` (branch 2, `:259`), where `readAt` is
the **attester's** last read from `tool-calls.jsonl` (`attesterReadTimes`,
`src/runtime/finalize-gate.ts:256-263`; `toolReadTimes`, `src/supervisor/finalization.ts:290`).

Replayed against `0026`'s own records with the shipped functions:

```
reviewer readAt  src/batch/prepare.ts            1794509066189   mtime 1794509178501
                 test/unit/batch-prepare.test.ts 1794509069498   mtime 1794509178502
attestedAt first FINAL_REPORT  1794509079205 → stale, no readAtMs  (branch 1)
attestedAt RESPONSE re-issue   1794509496823 → stale, with readAtMs (branch 2)
```

The supervisor asked the reviewer for a fresh block (`PROMPT`, 1794509490652); the reviewer sent one
as a `RESPONSE` carrying a `criteria` array (1794509496823), and `handleResponse` calls
`captureVerdicts` (`src/runtime/runtime.ts:1430`), so the clock did move. The gate refused 55 s later
anyway, on branch 2.

**Consequence: a re-issued attestation cannot clear staleness. Only a fresh read of the cited files
can.** `src/pi/supervisor-prompt.md:173-178` instructs "Re-ask the reviewer for a fresh block instead
of trying to reconcile the numbers by hand" — inert for this term.

## 4. Sandbox: what it is and what it costs

- `#487` — "batch: wrap the agent spawn in a macOS sandbox so model-authored code cannot write
  outside the clone". `#489` — "batch: confine the ticket run too — supervisor and every peer are
  separate sandboxed processes". Both closed (`gh issue view 487`, `gh issue view 489`).
- `src/batch/sandbox.ts` holds `sandboxProfile`, `sandboxedPaneCommand`, `sandboxAvailable`
  (`:76-80`), `agentConfigDir`. `MYPY_NO_SANDBOX=1` forces the unsandboxed answer (`:77-79`).
- Gated on `sandboxAvailable()`: the throwaway pi config (`src/batch/agent.ts:219`,
  `src/batch/executor.ts:386`) and, with it, the `--extension` flag and the pre-trusted
  `settings.json`.
- Cost recorded so far: three startup failures (`run.json` codes plus pane text), whose fixes are
  `592ee3e` (#548, the extension flag), `760a413` (#549, the `env` wrapper) and `b92e53f` (#552, the
  trust key); the `/Users/Shared` denials; and the availability test above.

Turning the sandbox off is **not** sufficient on its own, because:
- pi's `defaultProjectTrust` default is `"ask"` (`dist/core/settings-defaults.js`,
  `SETTINGS_DEFAULTS.defaultProjectTrust`), and `~/.pi/agent/settings.json` has no such key
  (`grep -c defaultProjectTrust` → 0). With the operator config, a fresh worktree prompts again.
- The operator config does register the extension, but by absolute path to the main checkout
  (`/Users/afshin/Documents/dev/multi-agent/src/pi/extension.ts`), not the worktree's.

So the throwaway config must become unconditional, not be removed with the sandbox.

## 5. Write guard: where it runs and what it checks

### 5.1 In a sandboxed run it is not loaded at all

- pi loads extensions from `join(agentDir, "extensions")`, where `agentDir` is
  `PI_CODING_AGENT_DIR`
  (`/Users/afshin/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:756-761`,
  the `agentRoots` list built from `this.agentDir`).
- `agentConfigDir()` builds a temp dir holding only `auth.json`, `models.json`,
  `models-store.json` (`src/batch/sandbox.ts:143`) plus a `settings.json` with the trust key
  (`:146-160`). There is no `extensions/` in it.
- Sandboxed launches point `PI_CODING_AGENT_DIR` at that dir (`src/batch/sandbox.ts:101`) and name
  only the worktree's own extension (`src/batch/executor.ts:386-390`).
- So in a sandboxed batch run the user guard is absent; the early return at
  `scripts/write-guard.ts:260` is never reached. With the operator config — the case once the sandbox
  is off by default — the shim loads and the early return applies.
- `~/.pi/agent/extensions/write-guard.ts` is a 261-byte shim: `export { default } from
  "/Users/afshin/Documents/dev/multi-agent/scripts/write-guard.ts";`.

### 5.2 The three checks, and what each block asks the peer to do

| Check     | Code       | Blocks                                                               | Remedy in the message                                       | Can a batch peer do it alone?             |
| --------- | ---------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| main      | `:264-273` | `edit`/`write` while HEAD is `main`                                  | "Cut one first: git switch -c task/<name> origin/main."     | yes                                       |
| reconcile | `:275-287` | the first file write of a turn until two lines are in the transcript | "state the reconcile line before the first write"           | yes; the rule is stated at `AGENTS.md:22` |
| mode      | `:289-306` | any write on a turn classified `answer`/`ambiguous`                  | "State what you would change and wait for the user's word." | **no** — a batch has no user              |

All three sit below `if (process.env.MYPY_UNATTENDED === "1") return;` (`:260`), so unattended runs
skip them together.

### 5.3 What the batch already enforces without it

`peerExtensions` loads `permissionGate` (`src/peer/peer-extensions.ts`), which denies bash commands
outside `shell_allow` and `edit`/`write` paths outside the work order's `writeScope`
(`src/peer/permission-gate.ts:29-55`; an absent scope means unrestricted, `:44-46`). The guard
therefore adds the branch rule, the reconcile line and the turn-mode licence — not path scope.

### 5.4 Evidence from the runs

- Real inputs, classified by replaying `writeMode()` over `0026`'s `conversation.jsonl`: implementer
  work order → `action`; reviewer work order → `action`; supervisor re-attest prompt → `ambiguous`.
- No `Write blocked` string appears in any `#541` record or in `0026`'s `run-details/`.
- The bypass is pinned by a test: `test/scripts/write-guard.test.ts:303-314`, "keeps the unattended
  batch bypass".
- Documented harm the main rule prevents: `docs/retro/2026-11-09.md:135` and `:143` ("Twice this
  session files were edited with `main`…"). That was an operator session, not a batch.
- No batch failure recorded in §3 or §4 is write-related: startup, validation, stale-attestation and
  reply format are the whole list. Nothing observed would have been caught by the mode or reconcile
  checks.

### 5.5 What has not been measured

- No batch run has executed with any of the three checks armed. Every run so far either had the
  guard absent (§5.1) or took the `:260` bypass, so the turn cost of arming the main check, the
  reconcile line or the mode licence in an unattended run is unmeasured.
- `test/scripts/write-guard.test.ts:303-314` pins the bypass as it is today.

### 5.6 `git merge-base` reads as a write

`scripts/write-guard.ts:35` lists `merge` among write verbs with a trailing `\b`, which matches
`git merge-base`. Reproduced: `bashWrites("git merge-base --is-ancestor 04f3514 origin/main")` →
`true`, and it blocked a read-only command on 2026-11-12 with the message at `:304`. Fix: require
whitespace or end of input after the verb (`…|merge|rebase|…)(?=\s|$)`), plus tests for
`git merge-base` and `git merge --ff-only`.

### 5.7 The mode classifier only reads the first word

`writeMode()` (`scripts/write-guard.ts:169-186`) looks for a write verb at the **start** of the turn's
text. A turn that opens with a statement and only later says "put the answer in the doc" classifies
`ambiguous`, and the guard refuses the write (`:289-306`). Observed on 2026-11-12: an explicit
instruction containing that phrase was refused with "State what you would change and wait for the
user's word", and the write landed only after the next turn opened with `apply`. This is the same
class of false negative as §5.6, and the reason §5.5 keeps the mode check bypassed for unattended
runs rather than arming it.

## 6. Is the `#541` change correct?

The change is uncommitted in `~/Documents/dev/ma-wt-0026-t541-t541`: `src/batch/prepare.ts` +11,
`test/unit/batch-prepare.test.ts` +24 (`git diff` there).

### 6.1 What it does

Inside `verifyTicket`, in the `if (repairable)` branch and before `flaggedRows` is computed, it
refuses when the first-pass block has a DoD-criterion mismatch:

```ts
const dodMismatch = block.dod?.find((v) => v.verdict === "mismatch");
if (dodMismatch !== undefined) {
  return fail("verifier-mismatch",
    `mismatch on DoD criterion ${dodMismatch.criterion} — see ${VERDICT_EVIDENCE}`);
}
```

### 6.2 Why that is safe (each point read from code)

- `DodVerdict.verdict` is `"match" | "mismatch"` (`src/batch/report.ts:72-76`), so `=== "mismatch"`
  is exhaustive; there is no third value the guard could miss.
- `acceptance` checks rows before DoD (`src/batch/report.ts:813-828`), which is why the base flow reported the
  row first and refused on the criterion only after the repair round — the premise of the issue.
- `block.dod === undefined` means the guard is skipped (optional chaining), so old replies behave as
  before. `blockShape` requires one DoD verdict per criterion when criteria exist
  (`src/batch/report.ts:776-779`), so `dod` present ⇒ criteria present.
- Placement inside `repairable` leaves every non-repairable refusal untouched, and the guard runs
  before `repairRound`, so no repair call is paid for.
- The criterion-only case keeps refusing; its detail changes from `mismatch on criteria N` (built by
  `flagged`, `src/batch/report.ts:631-645`, with `CRITERIA.plural = "criteria"`, `src/batch/report.ts:600`) to
  `mismatch on DoD criterion N`.

### 6.3 Empirical check — base versus change

A detached worktree at `d8c497e` (`git worktree add --detach /tmp/v541 d8c497e`), the new test file
copied in, `node_modules` symlinked:

| Tree                            | `bunx vitest run test/unit/batch-prepare.test.ts`                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| base `d8c497e` + new tests      | **1 failed \| 144 passed** — the combined-mismatch test fails with `code: "unverifiable"` because the base calls the repair agent and the scripted replies run out |
| `0026` worktree (base + change) | **145 passed**                                                                                                                                                     |

Full suite, same environment (`MYPY_UNATTENDED=1 MYPY_NO_SANDBOX=1 bun run test`):

| Tree                                                      | failures                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| main checkout at `d8c497e` + `04f3514` (no `#541` change) | `write-guard` ×10, `batch-sandbox` ×1 → **11**             |
| `0026` worktree (with `#541` change)                      | `write-guard` ×10, `batch-sandbox` ×1 → **11**, same files |

So the change introduces no new failures. A `/tmp` worktree adds one artefact failure,
`test/unit/antislop-scope.test.ts` ("expected 0 to be greater than 0"): it asserts that
`git ls-files --others --ignored --exclude-standard --directory` finds ignored directories
(`:60-70`), and a fresh worktree has none. Not a code failure.

### 6.4 Against the issue's Definition of Done

| Criterion (quoted from `gh issue view 541`)                                                                                                                                                                                                                                                              | Verdict | Evidence                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "A block that mismatches a DoD criterion refuses before the repair round, naming the criterion. Proof: a prepare test whose first block fails row 1 and criterion 1 asserts the outcome is `verifier-mismatch`, its detail names criterion 1, and the agent was called twice, triage and verifier only." | met     | in `0026`'s worktree, `test/unit/batch-prepare.test.ts:904-911` asserts `code: "verifier-mismatch"`, a `detail` containing `criterion 1`, and `calls() === 2`; it fails on base and passes with the change (§6.3) |
| "A block that fails a row and a criterion skips the repair round, while a block whose only failure is a row still enters it. Proof: one test asserts the repair agent is not called for the combined block, and an assertion on the call count shows the row-only block reaching it."                    | met     | `calls() === 2` in the combined test is the first half; in the same worktree, `test/unit/batch-prepare.test.ts:913-922` asserts `ok: true` and `calls() === 4` for the row-only block, which also passes on base  |

`0026`'s reviewer reached the same call: two criteria, both `pass`, "Standards — no findings. Spec —
no findings." (`FINAL_REPORT` payload in
`~/Documents/dev/ma-wt-0026-t541-t541/mypi-tasks/0026-t541-t541/run-details/conversation.jsonl`).
That attestation is independent evidence; §6.3 is the mechanical check.

## 7. Corrections to earlier reports

| Earlier claim                                                               | Reality                                                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| "`#541` cost ~$0.75"                                                        | correct: $0.7105 prepare + $0.61 run = $1.32                                                                                     |
| A later "$1.86 / $2.03"                                                     | wrong: double-counted the per-attempt cost written to both `decision.json` and `refusal.json`/`acceptance.json`                  |
| "3 accepted, 2 accepted runs"                                               | wrong: 4 accepted prepares, 4 run records (3 `startup-failed`)                                                                   |
| "stale-attestation because the supervisor stashed/popped after attestation" | incomplete: true, but the term that fired compares against the **attester's read time**; a re-issued attestation cannot clear it |
| "sandbox introduced in `#489`"                                              | imprecise: machinery `#487`, run wiring `#489`                                                                                   |
| "`git log --grep` finds no `#489`, so the attribution is unverified"        | wrong method: commit messages do not carry the number; `gh issue view 489` settles it                                            |

## 8. Not verified

- The verifier's `terminated` result in `0024` (`tickets/541/refusal.json`,
  `attempts/1/retries.json`). Provider side; no local reproduction.
- Whether the guard reads correctly when several criteria mismatch at once: it names the first.
  No test and no run exercises that case.
- The turn cost of arming any of the write guard's three checks in an unattended run (§5.5).

## 9. The gate's environment — measured, and what remains unmeasured

This document holds no proposals. Everything in this section is a command that was run or a
file:line that was read.

### 9.1 Where the gate command runs

- The command comes from the kind template: `templates/code-small.yaml:151-153` (`bun run check`).
- The runtime executes it in-process when the run finalizes: `runValidation` is called with
  `deps.execValidation` (`src/runtime/finalize-gate.ts:116-119`).
- `defaultExecValidation` spawns `sh -c <command>` **from the peer process**
  (`src/runtime/runtime.ts:97-101`).
- The supervisor process is launched under `sandbox-exec` when a throwaway config directory exists
  (`src/batch/executor.ts:390-402`).
- Read together: the gate's children are confined, so the gate does not run in the shell CI uses.

### 9.2 What fails unconfined (measured)

`MYPY_UNATTENDED=1 MYPY_NO_SANDBOX=1 bun run test` → 11 failed: `test/scripts/write-guard.test.ts`
×10, `test/unit/batch-sandbox.test.ts` ×1. Without the variable the write-guard file passes: 75
passed (`bunx vitest run test/scripts/write-guard.test.ts`).

### 9.3 The suites that need an unconfined process

- `test/integration/batch-sandbox.test.ts:30` and `test/integration/batch-run-sandbox.test.ts:18`
  place the fake HOME in `/Users/Shared` on purpose; the comment at
  `test/integration/batch-sandbox.test.ts:27-29` says a denial has to be the profile's rather than a
  temp root's.
- Measured: `sandbox-exec -p '<profile>' mkdir -p /Users/Shared/mypi-probe` →
  `Operation not permitted`. So the fixtures (`test/integration/batch-sandbox.test.ts:56`,
  `test/integration/batch-run-sandbox.test.ts:76`) cannot be built when the suite itself runs confined.
- Unconfined they pass: `bunx vitest run test/integration/batch-sandbox.test.ts
  test/integration/batch-run-sandbox.test.ts` → 10 passed, before and after the fix of §9.6.
- CI does not run them at all. `.github/workflows/check.yml:41` runs `bun run check`, but the job is
  `ubuntu-latest` (`.github/workflows/check.yml:14`) and `sandboxAvailable()` returns
  `existsSync("/usr/bin/sandbox-exec")` (`src/batch/sandbox.ts:17`, `:76-80`), while both files gate on
  it (`test/integration/batch-sandbox.test.ts:51`,
  `test/integration/batch-run-sandbox.test.ts:42`). On a host without that binary they are `it.skip`,
  so their only execution is a macOS host running them unconfined.

### 9.4 Traps in the existing tests

- Both suites gated only on `sandboxAvailable()` (`test/integration/batch-sandbox.test.ts:51`,
  `test/integration/batch-run-sandbox.test.ts:42`), which cannot distinguish "binary present and the
  process unconfined" from "the process confined". §9.6 adds the fixture probe as a second condition.
- `test/unit/batch-sandbox.test.ts:83-85` asserts that `MYPY_NO_SANDBOX=0` leaves availability as the
  filesystem reports it; a default that requires opting in breaks it (deduced from
  `src/batch/sandbox.ts:76-80`; the analogue at `:76-78` fails measurably under `MYPY_NO_SANDBOX=1`).
  No production change was made, so this stands.

### 9.5 The gate's failure list, measured

Reproduction, all functions from `src/batch/sandbox.ts`: `sandboxProfile({clone: <0026 worktree>,
configDir: <fresh mkdtemp>, home: homedir(), gitDir: gitDirOf(<worktree>)})` (`:37`), wrapped by
`sandboxedPaneCommand("MYPY_UNATTENDED=1 bun run check", profile, configDir)` (`:90-102`), run with
`sh -c` and `cwd` = the worktree. One difference from the real run: the run's config dir was deleted
when it ended (`src/batch/executor.ts:551`), so this rebuilds it.

Exit **1**. `bun run check` is a `&&` chain (`package.json`, `scripts.check`), so a step that ran
implies every earlier step exited 0.

| step               | exit | how it is known                                                                                               |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------------------- |
| `lint`, `lint:web` | 0    | `test` ran; warnings only (`Found 104 warnings`, `Found 1 warning`)                                           |
| `oxlint`           | 0    | `test` ran; warnings only (e.g. `src/batch/executor.ts:388:5: warning unicorn(no-useless-spread)`)            |
| `typecheck`        | 0    | run alone under the same profile                                                                              |
| `typecheck:web`    | 0    | run alone under the same profile                                                                              |
| `test`             | 1    | `Test Files 3 failed \| 140 passed \| 2 skipped (145)` / `Tests 16 failed \| 1829 passed \| 6 skipped (1851)` |
| `test:web`         | 0    | run alone under the same profile                                                                              |

The 16 failing tests, and the count matches `0026`'s `final.md` (16):

```
test/scripts/write-guard.test.ts (75 tests | 10 failed)
  blocks the first write until the reconcile line is in the transcript
  re-opens the gate on the next user turn
  blocks a repo write on main even when the turn asked for the work
  blocks a write on a question that asked for an answer
  blocks a write when the request only reads
  names the mode and the token that made a command a write (#491)
  refuses an inline program on a turn that only reads, whatever the program says (#491)
  blocks a write with no instruction, and asks in words instead of opening a dialog
  recomputes the mode for each input
  blocks a bash write, not only edit and write
test/integration/batch-sandbox.test.ts (6 tests | 6 failed)
test/integration/batch-run-sandbox.test.ts (whole file)
```

Causes, each with its proof:
- The ten `write-guard` tests: the ambient `MYPY_UNATTENDED=1` returns early at
  `scripts/write-guard.ts:260`, so the hook yields no block. Output: `AssertionError: expected
  undefined to match object { block: true }`, `TypeError: Cannot read properties of undefined
  (reading 'block')`. Without the variable the same file passes 75/75 (§9.2).
- Both sandbox suites: the fixture path is denied. Output:
  `Error: EPERM: operation not permitted, mkdtemp '/Users/Shared/mypi-sb-home-XXXXXX'` and
  `EPERM: operation not permitted, mkdtemp '/Users/Shared/mypi-run-sb-home-XXXXXX'`.

No other failure class appears: every other step of the chain exits 0 inside the same profile, so the
sandbox denies nothing the toolchain needs.

### 9.6 What the fix changed, and the gate afterwards

Three test files, no production code touched by this fix (`git status` in the `0026` worktree shows
these three next to `#541`'s own two files):
- `test/scripts/write-guard.test.ts:121` — the file's `beforeEach` deletes `MYPY_UNATTENDED`, so each
  test states the mode it exercises. Measured alone under `MYPY_UNATTENDED=1`: 75 passed.
- `test/integration/batch-sandbox.test.ts:37` and `test/integration/batch-run-sandbox.test.ts:25` —
  `fixtureBlocked` probes `mkdtemp` under `/Users/Shared` at module load and the suite gate requires it
  to be `undefined`; the cause is printed (`console.warn`) rather than swallowed.
- `test/integration/batch-sandbox.test.ts:55` — the file-level `beforeEach` builds no fixture when it
  is blocked, which the one fixture-free test (`says why it is skipped where there is no
  sandbox-exec`) needs: it runs everywhere.

Gate afterwards, same command as §9.5: exit **0**. `Test Files 142 passed | 3 skipped (145)`,
`Tests 1840 passed | 11 skipped (1851)`, then `test:web` `13 passed`, `57 passed`. Unconfined, the two
sandbox suites still report 10 passed.

Landed as PR #553, merge commit `d0a015e` on `main`, with the required `check` passing (44s).

## Appendix — re-running the verification

```bash
git rev-parse origin/main main                      # §1
ls -d mypi-tasks/000-batches/00*t541*/tickets/541/attempts/*/ | wc -l    # §2
# cost: sum costUsd from refusal.json/acceptance.json only, not every JSON (§2)
MYPY_UNATTENDED=1 MYPY_NO_SANDBOX=1 bun run test    # §3.1, §6.3
# stale: staleCitations + toolReadTimes from src/supervisor/finalization.ts,
#        fed 0026's tool-calls.jsonl and the worktree's file mtimes (§3.2)
# guard: writeMode / bashWrites from scripts/write-guard.ts, fed 0026's conversation.jsonl (§5.4, §5.6)
git worktree add --detach /tmp/v541 d8c497e         # §6.3 base-vs-change
```
