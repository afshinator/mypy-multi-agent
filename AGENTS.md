# mypy-multi-agent

Local-first multi-agent orchestration for software-engineering work, built on pi + herdr. See `README.md`.

Specs and work items live as GitHub issues in `afshinator/mypy-multi-agent`. `docs/multi-agent-spec-v1.6.md` is retained as a historical product spec only; the issue tracker is the source of truth for changes.

## Task-run discipline

- A finished task run is frozen. Never edit a completed run's `session.yaml` or its `run-details/` artifacts.
- "identify" / "review" / "summarize" / "make sure next time" are answer-only. Edit files only when the exact file is named and an action word ("edit", "fix", "do it", "go", "land") is given.
- Lessons for the next task go into `templates/` and `docs/agent-config-guide.md`, never into a completed run's config.
- `main` is protected. Never push to it: land a task branch with `just land` (push, PR, wait for `check`, rebase merge). A refusal that names `just land` is the gate working.
- If you already committed on `main`, the commit is stranded, not lost: protection is on the push. Move it before landing: `git switch -c task/<name>`, then `just land`.

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
