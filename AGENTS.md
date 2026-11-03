# mypy-multi-agent

Local-first multi-agent orchestration for software-engineering work, built on pi + herdr. See `README.md`.

Specs and work items live as GitHub issues in `afshinator/mypy-multi-agent`; the issue tracker is the source of truth for changes. `docs/agent-config-guide.md` documents the shipped behaviour; `CODING_STANDARDS.md` holds the rules a review applies.

## Reply discipline

Every reply ends with exactly one of these two lines, verbatim in shape:
- `ACTION REQUIRED — you: <one sentence naming the single thing only the human can do>`
- `NO ACTION REQUIRED — you: <what happens next and who does it (usually: me)>`

Rules that make that line true:
- **One action at a time.** If more than one thing is pending, name only the first and say the rest are queued behind it. Never list several things for the human to choose between and call it one action.
- **Blocking vs queued.** An action is _required_ only if my next step cannot start without it. Anything I can do myself is never an action for the human — it goes in the "next" half of the NO-ACTION line.
- **No implied asks.** Anything that sounds like a request ("you approve", "pick one", "say go") must appear inside the ACTION REQUIRED line, or be removed. A "critical" note is a warning about the work, not a task for the human, unless it says so in that line.
- **Silence is not approval.** If an action is required, do not start the work it gates.

## Task-run discipline

- A finished task run is frozen. Never edit a completed run's `session.yaml` or its `run-details/` artifacts.
- "identify" / "review" / "summarize" / "make sure next time" are answer-only. Edit files only when the exact file is named and an action word ("edit", "fix", "do it", "go", "land") is given.
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

## Shell

- The shell already starts in the working directory you were given, so a command needs no `cd` prefix (#126).
- macOS userland, no GNU coreutils: there is no `timeout` (pass the tool's own timeout argument), BSD `cat -A` is `cat -vet`, and system `python3` has no `yaml` — use `bun -e`, which does (#128).
- `rg` recurses by default. `-r` means **replace** and silently rewrites its own output, so it must never be passed meaning "recursive" (#128).
- `@-` reads stdin only for `gh api -F` (typed) or `--input -`. `-f body=@-` posts the literal string `@-`, which is how every batch comment body was wrong until #225: put the text in argv.
- `gh issue view --json comments` returns GraphQL node ids (`IC_kwD…`), which are not patchable. Editing or deleting a comment needs the REST numeric id from `gh api repos/{owner}/{repo}/issues/comments` (#225).
- `pi --list-models <slug>` exits 0 when nothing matches: it searches. Validating a slug means `resolveModels` in `src/batch/preflight.ts`.
