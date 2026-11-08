# mypy-multi-agent

Local-first multi-agent orchestration for software-engineering work, built on pi + herdr. See `README.md`.

Specs and work items live as GitHub issues in `afshinator/mypy-multi-agent`; the issue tracker is the source of truth for changes. `docs/agent-config-guide.md` documents the shipped behaviour; `CODING_STANDARDS.md` holds the rules a review applies.

## Reply discipline

Every reply hands the decision back: the turn ends, and nothing continues until you send something. So
no reply claims the work carries on by itself.
- **One next step.** Name the single thing you do next, by number where one exists. Anything else
  pending comes after it, not beside it. Never a menu dressed up as one action.
- **No implied asks.** A warning about the work is a warning, not a request. If something needs your
  word, say so plainly instead of letting a note imply it.
- **Silence is not approval.** A described next step is not a promise to perform it; work that needs
  your word waits for it.

## Task-run discipline

- A finished task run is frozen. Never edit a completed run's `session.yaml` or its `run-details/` artifacts.
- "identify" / "review" / "summarize" / "make sure next time" are answer-only. Edit files only when the exact file is named and an action word ("edit", "fix", "do it", "go", "land") is given.
- An edit request authorizes the working-tree change and nothing else. Committing, creating a branch, pushing and landing each need their own instruction; a change nobody asked to land stays uncommitted.
- Create a branch with an explicit start point: `git switch -c <name> origin/main`. A bare `git switch -c` branches from whatever the last operator left checked out, so a branch cut from another unlanded branch makes a PR that carries two changes and conflicts with `main`, where no check can register.
- Lessons for the next task go into `templates/` and `docs/agent-config-guide.md`, never into a completed run's config.
- `main` is protected. Never push to it: land a task branch with `just land` (push, PR, wait for `check`, rebase merge). A refusal that names `just land` is the gate working.
- If you already committed on `main`, the commit is stranded, not lost: the ruleset refuses the push, so nothing reaches the remote. Move it before landing: `git switch -c task/<name>`, then `just land`.
- The gate is the server-side `main-protection` ruleset, not the pre-push hook (`--no-verify` skips that). Read it with `gh api repos/afshinator/mypy-multi-agent/rulesets/26223811`. Its `pull_request` rule must keep `required_approving_review_count: 0` **and** `require_extra_approval_for_unattributed_changes: false`: a solo maintainer cannot approve, and commits by `pi subagent <subagent@local>` are unattributed, so either setting blocks every landing with no way to approve it. Keep `bypass_actors` empty too — an entry reopens the direct-push path.

## Agent skills

### eng-skills workflow

These skills (linked in `.agents/skills` → `~/.agents/skills`, so they update themselves; a machine without that directory falls back to the global copy) own the flow. Reach for the named one instead of freelancing its job:

| Job                                             | Skill                                         |
| ----------------------------------------------- | --------------------------------------------- |
| stress-test a plan before building              | `/skill:grilling`                             |
| turn the conversation into a spec               | `/skill:to-spec`                              |
| break a spec into blocked tracer-bullet tickets | `/skill:to-tickets`                           |
| move issues through triage roles                | `/skill:triage`                               |
| build from a spec or ticket                     | `/skill:implement` (test-first: `/skill:tdd`) |
| review a branch or a diff                       | `/skill:code-review`                          |
| pin down a term or record a decision            | `/skill:domain-modeling`                      |
| find deepening opportunities                    | `/skill:improve-codebase-architecture`        |

A ticket reaches `/skill:implement` once it carries `ready-for-agent`; until then it has not been triaged.

### Issue tracker

GitHub issues in `afshinator/mypy-multi-agent`, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label strings unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/` (index in `docs/adr/README.md`). See `docs/agents/domain.md`.

## Verdict contract

`{criterion, result, evidence}` per DoD criterion, quoted verbatim. Four layers — change them together:
- schema + parser: `src/contracts/criteria.ts`
- comparison: `src/supervisor/finalization.ts` (`criteriaMismatches`)
- prompt copies: the batch templates (`mypi-batch.yaml` kind_templates), `src/pi/supervisor-prompt.md`, and single-task templates naming the verdict fields
- guard: `test/integration/guardrails.test.ts` derives the copy set, so a new copy is caught automatically

## Shell

- The shell already starts in the working directory you were given, so a command needs no `cd` prefix (#126).
- macOS userland, no GNU coreutils: there is no `timeout` (pass the tool's own timeout argument), BSD `cat -A` is `cat -vet`, and system `python3` has no `yaml` — use `bun -e`, which does (#128).
- `rg` recurses by default. `-r` means **replace** and silently rewrites its own output, so it must never be passed meaning "recursive" (#128).
- `@-` reads stdin only for `gh api -F` (typed) or `--input -`. `-f body=@-` posts the literal string `@-`, which is how every batch comment body was wrong until #225: put the text in argv.
- `gh issue view --json comments` returns GraphQL node ids (`IC_kwD…`), which are not patchable. Editing or deleting a comment needs the REST numeric id from `gh api repos/{owner}/{repo}/issues/comments` (#225).
- `pi --list-models <slug>` exits 0 when nothing matches: it searches. Validating a slug means `resolveModels` in `src/batch/preflight.ts`.
