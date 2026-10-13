# Handoff — verifier allowlists cannot satisfy the reproduction duty (from mcp-server-go-quality run 1)

**Target repo:** `multi-agent` at `/Users/afshin/Documents/dev/multi-agent`
**Evidence:** `~/Documents/dev/mcp-server-go-quality/.mypi/task-t3-t4-hardening/run-details/`
(`final.md`, `plan.md`, `conversation.jsonl`)
**Companion doc:** `docs/rt8-adversarial-round-hardening.md` (RT-8, uncommitted at time of writing)
**Status:** not implemented. A config-side workaround exists and is verified; the harness is unchanged.

## Why this doc exists

RT-8 was written as recommendations from a template diff. A live run has now turned one of its
latent defects into a **measured, reproducible blocker**, and produced a second finding RT-8 does
not cover: the defect is not confined to the template — it is a **structural contradiction between
`canShell` and any config that asks one peer to reproduce another peer's command**.

Run 1 failed honestly (`exit_code: 1`, 0 commits, 0 files changed) at $0.28. The failure was
*correct* — the supervisor applied the rules it was given. The rules were self-contradictory, and
nothing in the harness could detect that.

## Findings

- **F1 — 68 commands were refused in a single run.** `src/pi/tool-permissions.ts:19-23` matches the
  **exact command string** (`Array.includes`). A config that gives a read-only verifier a fixed
  allowlist therefore forbids every command not on that list, verbatim.

- **F2 — the blocked set is the ordinary work vocabulary, not exotic commands.** Every command
  below was refused during the run; the right-hand column is what the allowlist actually contained.
  Note the flag-order sensitivity in rows 2–3: `-count=1` before the package path was never
  allowed, only after it.

  | Refused | In the allowlist instead |
  |---|---|
  | `go test ./internal/runner` | `go test ./internal/runner/...` |
  | `go test ./internal/runner -count=1` | — |
  | `go test ./internal/runner -run 'TestExecRunner(TimeoutSurfacesDeadline\|RealExitKeepsItsOwnError)' -count=1` | — |
  | `go test -short -v ./internal/runner` | `go test -short ./...` |
  | `go test ./internal/...` | — |
  | `go test ./...` | — |
  | `make test` | — |
  | `git diff -- internal/runner/runner_test.go cmd/mcp-server-go-quality/main_test.go internal/checkers/orchestrator_test.go` | `git diff` |
  | `go run /tmp/cancel-waitdelay.go` | — |
  | `grep -nE 'schedule:\|golangci-lint/v2\|golang.org/x/vuln\|go.uber.org/nilaway\|DefaultVersion\|proxy.golang.org' .github/workflows/pin-drift.yml` | — |

  **Row 3 was D1's named falsifier.** It was the one command the protocol required the adversary to
  run, and it was unrepresentable in the allowlist. The supervisor then correctly rejected the
  round for "falsifier named but not executed".

  The last row is a command the supervisor itself invented to satisfy the attestation table. The
  verification machinery generated a check the verifier was not permitted to perform.

- **F3 — the contradiction is structural, and RT-8 makes it worse.** `spec-plan-adversarial` and
  RT-8's R5 require a *different-model peer to reproduce the author's claim* and to *execute the
  author's named falsifier*. Both duties take a command chosen by **another peer**. An exact-match
  allowlist cannot express that by construction. R5 as written is unsatisfiable on any peer with
  `edit: false`. This is not a template bug to be fixed by better discipline — the two requirements
  are mutually exclusive as implemented.

- **F4 — the loop is expensive and undetectable up front.** The supervisor correctly applied the
  "falsifier named but not executed → reject the round" rule, re-asked, and hit the same wall. The
  run burned both of D1's rounds, never started D2, and spent 12% of budget for zero output. No
  diagnostic warned the config author that the requirement could never be met. The harness cannot
  currently tell "the peer failed" from "the peer was never permitted to try".

- **F5 — RT-8's D1 is confirmed.** `spec-plan-adversarial.yaml`'s `consistency_verifier` declares
  `read: true, edit: false, shell: true` with no `shell_allowlist`, so `[].includes(command)` is
  always false: the peer advertised as the independent verifier has **no command access at all**.
  Any `final.md` of that template claiming independent verification is claiming something that did
  not happen.

- **F6 — a workaround exists and needs no harness change.** Declare the permitted commands once, as
  a *vocabulary*, and mirror that exact list into every read-only peer's `shell_allowlist`. The
  second run's config does this and was machine-verified so that
  `vocabulary ≡ adversary.allowlist ≡ ponytail.allowlist` (exact strings, both directions),
  with the implementer required to name its falsifier from that list. It also pre-empts a
  follow-on trap: `grep` exits 1 on no match, which is the *passing* result for an absence
  criterion and is otherwise read as a failure.

## Decisions

- **D1 — fix the mechanism, not just the templates.** Three options, in preference order:
  1. **Add a `shell_allowlist_mode`** (`exact` | `prefix`) so a config can allow
     `go test -count=1 ./...` and its variants without enumerating every form.
  2. **Add a config-level `shell_vocabulary`** that the loader writes into the prompt *and* into
     every read-only peer's allowlist, so the two cannot drift. This is the F6 pattern promoted
     into the contract.
  3. Fix only the templates with hand-curated allowlists. Cheapest, and it leaves F3 unfixed for
     the next author.

- **D2 — keep `canShell` default-deny.** Do not loosen it to "safe command" inference. The defect
  is lack of expressiveness, not excess strictness, and an inferred-safe shell is how a read-only
  peer stops being read-only.

- **D3 — make the contradiction detectable at validation time.** At minimum, reject or warn on a
  read-only peer with `shell: true` and an empty allowlist (F5). Better: when a config's prompts
  contain a reproduction/falsifier duty, warn if the named peer's allowlist cannot express an
  arbitrary command.

- **D4 — do not weaken the reproduction duty to compensate.** R5 is worth keeping; the fix belongs
  in the permission model.

## Actions

- **A1** Add the guardrail from RT-8's test plan to `test/integration/guardrails.test.ts`:
  every template agent with `permissions.shell === true && permissions.edit === false` must declare
  a non-empty `shell_allowlist`. This catches F5 and fails until
  `spec-plan-adversarial.yaml` is fixed, which is the point.
- **A2** Choose and implement one of D1's options; add contract tests for the mode or vocabulary.
- **A3** Implement D3's validation diagnostic with a test that a permissive config still passes.
- **A4** Update `docs/agent-config-guide.md` §4. It states the exact-match rule but does not warn
  that it makes **any** cross-peer reproduction duty unsatisfiable — the sentence that matters.
- **A5** Amend the guide's "process requirements … never written into the DoD" wording, per the
  open question in RT-8. The template puts diverge-and-defend in the DoD and is right to: the run
  contract only checks that `plan.md` exists (`src/validation/run-contract.ts`), so a process
  criterion is enforceable in the DoD and unenforceable outside it.
- **A6** Re-read RT-8's R5/R9 against F3 and note in that doc that the duty is blocked on A2.

## Reference implementation

The config that works around F3 without harness changes, as a pattern to copy:

```
DECLARED COMMAND VOCABULARY — the only shell commands the read-only peers can run, verbatim:
  git status / git diff / git diff --stat / git log --oneline -8
  go build ./... / go vet ./...
  go test -count=1 -short ./...
  go test -count=1 ./internal/runner/... etc.
  go list -m -json <module>@latest
  grep -n runtime.GOOS internal/runner/runner.go
  grep -n shortcut: internal/runner/runner.go
```
with, enforced in the supervisor prompt: *any falsifier must be one of those exact strings; a
command not in the list is refused outright; do not ask a verifier to run a command it cannot run.*

Live example: `~/Documents/dev/mcp-server-go-quality/.mypi/task-hardening-02/session.yaml`
(the second run, staged). The failed first run is preserved beside it as
`.mypi/task-t3-t4-hardening/`.

**Note for whoever picks this up:** the workaround is a config convention, not a guarantee. It
depends on the author enumerating the vocabulary correctly and on the two lists not drifting. A2 is
the fix that removes the author from the loop.
