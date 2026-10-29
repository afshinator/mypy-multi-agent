# mypy-multi-agent

Local-first multi-agent orchestration for software-engineering work: one supervisor agent directs a roster of peer agents running in terminal panes, and the run is judged against an explicit Definition of Done. It exists so a coding task can be split across concurrent, independently configured agents without leaving the machine.

## Language

### The run

**Run**:
One supervised piece of work, from `/mypi-multi-agent` to `final.md`.
_Avoid_: session, job, project

**Task**:
A directory under one of the configured `taskDirs` that holds one run's manifest and its output.
_Avoid_: job, work item, run directory, ask directory, output dir, workdir

**Project root**:
The directory the run inspector is pointed at; it may contain a `mypi-multi-agent.yaml` declaring the `taskDirs`.
_Avoid_: workspace, repo root

**Ask**:
The request block of a manifest: title, description, and Definition of Done.
_Avoid_: prompt, brief, spec

**Definition of Done (DoD)**:
The checkable criteria that decide whether a run succeeded.
_Avoid_: acceptance criteria, requirements, goals

**run-details/**:
A run's output directory: artifacts and logs.
_Avoid_: output dir, artifacts dir, ask dir

**Post-mortem**:
A read-only task over completed runs: its product is `run-details/findings-summary.md`, not
a code change. Each target is named by its task directory; the document is the one artifact
the supervisor writes itself.
_Avoid_: retro, review, audit, incident report

### The agents

**Supervisor**:
The interactive agent that decomposes the ask, hands out work, reconciles reports, and finalizes.
_Avoid_: orchestrator, lead, manager, controller

**Peer**:
A headless agent process in its own pane, holding one role from the roster.
_Avoid_: worker, subagent, child, agent

**Roster**:
The set of peers a manifest configures, each with its own model, permissions, and budget.
_Avoid_: team, agents list

**Attester**:
The one peer whose verdict block the finalize gate trusts.
_Avoid_: reviewer, approver

**Briefing**:
The text the supervisor receives at run start, assembled from the manifest.
_Avoid_: context, setup message, prompt

### The bus

**Bus**:
The local socket that carries envelopes between agents.
_Avoid_: broker, queue, network, A2A

**Frame**:
One JSONL line on the wire, before validation.
_Avoid_: message, packet

**Envelope**:
The validated object parsed from a frame: id, sender, recipient, type, payload.
_Avoid_: message, packet

**Work order**:
A bounded assignment from the supervisor to one peer, with its own local DoD.
_Avoid_: ticket, task, job

**Dispatch**:
Handing a work order to a peer over the bus.
_Avoid_: assign, send, enqueue

**Prompt / Response**:
A conversational exchange carrying a correlation id, so the reply is matched to its request.
_Avoid_: request, query, message

**Settle**:
A peer finishing a turn, leaving its transcript complete.
_Avoid_: finish, idle, complete

**Stall**:
An open turn that reported no progress for `stall_timeout_ms`. Noticed, never acted on: the peer keeps working.
_Avoid_: hang, freeze, timeout

### The outcome

**Verdict block**:
A peer's fenced JSON list, one pass/fail verdict per DoD criterion with its evidence.
_Avoid_: attestation, results, scores

**Finalize gate**:
Everything that must hold at once for a run to succeed: the supervisor's call, the attester's verdicts, fresh citations, the validation gate, and the run contract.
_Avoid_: done check, approval, sign-off

**Run contract**:
The artifacts every run owes the system regardless of its DoD.
_Avoid_: requirements, checklist

**Validation gate**:
The configured commands that must pass before a run that changed code can succeed.
_Avoid_: tests, CI, checks

**final.md**:
A run's terminal artifact: outcome, decision record, cost.
_Avoid_: report, summary

**findings.md**:
A run's raw peer reports, unedited.
_Avoid_: report, results

### Spend and health

**Bound**:
A peer's ceiling, in dollars or tokens. The token bound counts request tokens and excludes cache reads.
_Avoid_: quota, limit, cap

**Threshold**:
The share of a bound at which a peer is stopped.
_Avoid_: limit, ceiling

**Scorecard**:
A run's derived health metrics, written only when the manifest opts in.
_Avoid_: report, metrics, analytics

**Ledger**:
The append-only cross-project file of scorecards.
_Avoid_: database, log, history

**Injection gate**:
An opt-in classifier screen that annotates inbound peer prose. It never drops, reroutes, or re-ranks a message.
_Avoid_: firewall, filter, sanitizer

**Verdict advisory**:
An opt-in classifier judgement over each verdict's evidence. It never changes the exit code.
_Avoid_: review, second opinion, audit
