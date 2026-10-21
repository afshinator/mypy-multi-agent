# Analysis Task Design (Research Phase)

**Status:** Exploratory / Pre-spec. Not part of the frozen multi-agent contract.

**Purpose:** Formalize the feedback-loop idea — reusing run artifacts to analyze what went wrong and drive template hardening.

**Scope:** MVP design only. Implementation deferred pending calibration of signal quality.

---

## Motivation

After a task run completes, we have:
- Scorecard: derived metrics (cost, turns, tool errors, mistakes, retries).
- Decision record: supervisor's tensions and calls.
- Peer findings: individual agent notes on confusion, misalignment, shortcuts.
- Full transcript: conversation.jsonl and tool-calls.jsonl.

**Gap:** No systematic process to extract actionable template improvements from this data.

**Idea:** Post-run analysis task — multiple specialist agents analyze the same tasks from different angles, a reviewer grounds their findings, and a human decides whether to change the template. Personas specialize in what they're good at spotting (cost anomalies, vague specs, prompt confusion).

---

## MVP: The 3+1 Agent Model

### Workers (3 Personas)

Each receives a **data manifest** listing all available artifacts from the input task runs. Default data varies by persona; all agents can request additional data if needed.

**Data manifest includes:**
- `final.md` (frontmatter + decision record)
- `scorecard.json` (derived metrics)
- `findings.md` (peer notes)
- `conversation.jsonl` (full transcript, optional per agent)
- `tool-calls.jsonl` (tool invocations, optional per agent)

#### 1. Cost Auditor
- **Pre-loaded data:** scorecard.json, final.md frontmatter (cost breakdown).
- **Can request:** conversation.jsonl (to verify turn-duration claims), tool-calls.jsonl (to correlate cost with tool usage).
- **Looks for:** Spending anomalies, inefficient agent pairings, token waste, phase-specific budget burns.
- **Outputs:** "Implementer phase burns 40% of tokens; template allocates equal budget per agent" → recommend increasing implementer max_tokens or decreasing max_cost_usd elsewhere.
- **Signal type:** Deterministic (scorecard is ground truth).

#### 2. Spec Ambiguity Finder
- **Pre-loaded data:** final.md decision record, DoD criteria, findings.md.
- **Can request:** conversation.jsonl (to trace re-dispatch cycles), tool-calls.jsonl (to correlate scope creep with tool invocations).
- **Looks for:** Vague criteria, scope creep, missing checkpoints, requests re-dispatched >2x for the same thing.
- **Outputs:** "Criterion 3 'architecture is sound' was ambiguous; architect re-asked implementer twice" → recommend rewording to "all exported interfaces documented with examples."
- **Signal type:** Pattern in re-dispatches and supervisor reversals.

#### 3. UX Friction Detector
- **Pre-loaded data:** conversation.jsonl (full transcript), findings.md, final.md decision record, scorecard.json (turn durations, retries).
- **Can request:** tool-calls.jsonl (to correlate agent confusion with specific tool invocations).
- **Looks for:** Repeated clarifying questions (agents ask the same thing twice), turn bloat (turns get progressively longer), backtracking (supervisor reverses peer work), re-dispatch cycles (work order sent back >2x).
- **Outputs:** "Implementer tried feature X when spec said features Y,Z only; conversation shows 4 clarifications on scope" → recommend hardening the ask with explicit "out of scope" list or narrowing the system prompt.
- **Signal type:** Patterns in communication flow (questions, reversals, re-dispatches).

### Reality Checker (Reviewer)

One agent, reviews all three findings in parallel.

- **Pre-loaded data:** All three agents' findings, full data manifest (final.md, scorecard.json, findings.md, conversation.jsonl, tool-calls.jsonl).
- **Mandate:** Ground-check each finding against available data, resolve conflicts, rank by confidence and impact.
- **Moves:**
  - *Ground check:* "Cost Auditor claims phase 2 token waste. Can I verify this in the scorecard? Did they cite conversation.jsonl? Do the numbers match?" Yes/No/Partial.
  - *Data traceability:* Note what data each agent accessed (or didn't access) for their claim. Missing access is a signal: "Spec Finder didn't request conversation.jsonl but claimed turn-pattern evidence" → less reliable.
  - *Conflict resolution:* "Spec Finder says DoD was vague. Friction Detector says prompt was clear, agent misread. Which is it?" → examine conversation.jsonl for evidence.
  - *Confidence ranking:* GOLD (concrete data, actionable, high confidence) / SILVER (pattern visible but needs confirmation) / BRONZE (speculative, needs more data).
- **Output:** `verified-findings.md` with each finding tagged by confidence and data sources cited.

### Supervisor (Existing Role, Narrower Mandate)

The supervisor orchestrates the analysis, not the template decision.

- **Phase 1: Load & curate.** Read input task paths; extract final.md frontmatter, scorecard.json, decision record, findings.md, (optionally) transcript excerpts (decision-point exchanges only).
- **Phase 2: Dispatch workers.** Broadcast all 3 task summaries to all 3 agents in parallel. Each agent analyzes independently.
- **Phase 3: Collect findings.** All 3 finish; supervisor reads all findings.
- **Phase 4: Dispatch reviewer.** Send all 3 findings + original task data to reviewer. Reviewer does ground-check + ranking.
- **Phase 5: Reconcile.** Minimal: check that all 4 agents settled. Optionally flag internal contradictions.
- **Phase 6: Finalize.** Write final.md with:
  - Consensus findings (all/most workers agree).
  - Divergences (worker disagreements + reviewer arbitration).
  - Recommendation priority (which template changes, if applied, would have highest impact + confidence).
  - DoD: "Reviewer verified at least 2 GOLD findings" or "consensus achieved on N patterns."

---

## Workflow

### Setup
1. User creates `mypi-tasks/feedback-batch-1/session.yaml` from a analysis template.
2. Names 3–5 recent task paths in `session.input_tasks`.
3. Optionally sets `analyze.template_target` to track which template is being audited.

### Execution
```
/mypi-feedback feedback-batch-1
```
Supervisor spawns the 3 workers + reviewer (4 agents total). All read-only (no shell, no edit).

### Output
- `run-details/final.md`: Supervisor's decision record + recommendation priorities.
- `run-details/findings.md`: Raw per-agent findings (Cost Auditor, Spec Finder, Friction Detector).
- `run-details/verified-findings.md`: Reviewer's ground-check + confidence ranking.

### Human Action
1. Read `final.md` + `verified-findings.md`.
2. Decide whether to apply recommended template changes.
3. Edit `templates/tdd-build.yaml` (or whichever template was audited).
4. Commit with message: `"template: increase implementer max_tokens (feedback-batch-1, gold finding from cost-auditor)"`.
5. Optionally tag in `quality/improvements.json`:
   ```json
   {"change":"abc1234","class":"M3","beforeCount":25,"template":"tdd-build.yaml","personas":["cost-auditor"]}
   ```
   (enables future scorecard trend measurement).

---

## Config Schema (MVP)

```yaml
version: "1.2"

session:
  id: "feedback-batch-1"
  role: "analysis"  # new; supervisor branches on this
  max_cost_usd: 2.00  # cheaper than normal runs (read-only agents)
  input_tasks:
    - ../04-inspector-server/
    - ../s6-tracing/
    - ../s7-metrics/
  attester: "reviewer"  # only reviewer's verdict gate matters

analyze:
  title: "Tuning tdd-build.yaml: cost and spec clarity"
  template_target: "tdd-build.yaml"  # optional metadata for documentation
  success_criterion: "reviewer verified at least 2 GOLD findings; consensus on root causes"

agents:
  - id: "cost-auditor"
    title: "Cost Auditor"
    model: "deepseek/deepseek-v4-pro"
    permissions: { read: true, edit: false, shell: false }
    system_prompt: |
      You are the Cost Auditor. Your expertise: spending patterns, token
      allocation, and budget misalignments in multi-agent runs.

      Given 5 task runs on the same template, analyze their scorecards.
      Look for:
      - Phases where agents consistently burn budget (e.g., 60% of tokens in one phase).
      - Per-agent spending that suggests misconfiguration (e.g., cheap agent does half the work).
      - Token waste patterns (retries, long turns, empty model output).

      Output format: one finding per section. Each finding: the symptom,
      the scorecard evidence, and a recommendation (e.g., "increase max_tokens" or
      "split the agent into two specialized roles").

      Be concrete. Cite scorecard values. Do not speculate.

  - id: "spec-finder"
    title: "Spec Ambiguity Finder"
    model: "deepseek/deepseek-v4-pro"
    permissions: { read: true, edit: false, shell: false }
    system_prompt: |
      You are the Spec Ambiguity Finder. Your expertise: rooting out vague
      requirements that waste agent effort.

      Given 5 task runs, read their decision records (the supervisor's tensions,
      reversals, and re-dispatches) and the DoD criteria.
      Look for:
      - Criteria that are so vague agents asked for clarification (evidence: repeated re-dispatches).
      - Scope creep signals (supervisor re-dispatches "add feature X" when plan said no X).
      - Missing checkpoints (supervisor had to invent a verification step mid-run).

      Output format: one finding per section. Each finding: the vague criterion
      or missing scope marker, the evidence (re-dispatch count, supervisor call),
      and a recommendation (e.g., "reword criterion 3 to 'all exported interfaces
      documented with examples'" or "add an explicit out-of-scope list to the ask").

      Be concrete. Cite decision record quotes. Do not speculate.

  - id: "friction-detector"
    title: "UX Friction Detector"
    model: "deepseek/deepseek-v4-pro"
    permissions: { read: true, edit: false, shell: false }
    system_prompt: |
      You are the UX Friction Detector. Your expertise: prompt clarity,
      agent confusion, and unmet expectations.

      Given 5 task runs, read their peer findings (agent notes on confusion,
      misalignment, re-checks) and the supervisor's decision record.
      Look for:
      - Patterns where agents misunderstood the ask (evidence: supervisor notes
        "implementer took feature X when spec said Y").
      - Prompts that are too generic or context-sparse (evidence: multiple agents
        asked the same clarifying question).
      - Scope boundaries that agents crossed (evidence: peer findings note "unclear
        whether X was in scope").

      Output format: one finding per section. Each finding: the confusion type,
      the evidence (peer notes, supervisor decision quotes), and a recommendation
      (e.g., "add an explicit 'out of scope' section to the system prompt" or
      "split the agent role into two narrower ones").

      Be concrete. Cite peer findings. Do not speculate.

  - id: "reviewer"
    title: "Reality Checker"
    model: "deepseek/deepseek-v4-pro"
    permissions: { read: true, edit: false, shell: false }
    system_prompt: |
      You are the Reality Checker. Three specialists analyzed the same 5 runs;
      your job is verification and arbitration.

      For each finding submitted by Cost Auditor, Spec Finder, and Friction Detector:
      1. Ground-check: Can I verify this in the provided scorecard/decision/findings data?
         Answer: YES (concrete evidence) / PARTIAL (pattern visible but incomplete) / NO (hallucinated or contradicted).
      2. Conflict resolution: Do the three analyses agree or contradict? If they contradict,
         which agent's evidence is stronger?
      3. Impact ranking: If applied, would this template change reduce the problem? How
         much evidence supports it?
      4. Confidence label: GOLD (concrete data, high confidence, actionable) / SILVER (pattern
         visible but needs more runs to confirm) / BRONZE (speculative, needs more data).

      Output format: one finding per section. Restate the finding, cite the evidence,
      note conflicts/agreements with other agents, and assign a confidence label.
      Findings should be ranked by confidence and impact.

      Be rigorous. Do not accept a claim without evidence. Do not invent data.
```

---

## Resolved Design Decisions

**Data transparency:** All agents receive a data manifest showing what's available. Default pre-loaded data varies by persona (Cost Auditor: scorecard; Spec Finder: decision record; Friction Detector: full JSONL). All agents can request additional data if needed. Reviewer tracks which data each agent accessed, enabling confidence scoring based on evidence grounding.

**Batch scope:** Author specifies in `session.input_tasks`. Default if omitted: all runs in a designated directory (e.g., `../` scans for run-details/). No limit on template variety within a batch.

**Supervisor decision record:** Include both raw findings and ranking by confidence + impact.

**Template change measurement:** Whoever proposes a change also proposes the measurement method upfront (e.g., "measure M3 rate before/after"). That proposal goes into `quality/improvements.json` along with the commit hash, template name, and recommending personas. The scorecard ledger then confirms or refutes the change in follow-up runs.

**Task lifecycle:** This is a new task type, not a "analysis" service. User creates `mypi-tasks/feedback-batch-1/session.yaml`, configures it, and runs it like any other task: `/mypi-multi-agent feedback-batch-1`. On-demand. No scheduling.

---

## What This Is NOT (MVP Scope Boundary)

- Auto-applying template changes. Output is a report; a human decides.
- Integration with CI/CD. No automatic PR creation; the human writes the commit.
- Feedback on code changes. Personas only analyze task-run metadata (scorecard, decision, findings), not diffs.
- Real-time feedback. This is post-hoc analysis, run after tasks complete.
- Replacing the supervisor. The analysis task is a separate run type; normal task runs are unaffected.

---

## Risks & Mitigations

**R1: Signal noise — agents hallucinate patterns.**  
*Mitigate:* Persona system prompts are detailed with examples. Reviewer ground-checks every claim. Start with curated excerpts, not full JSONL. Beta-test on 2–3 known-good batches before production use.

**R2: False consensus — all agents agree on something wrong.**  
*Mitigate:* Reviewer is the human check; findings are a record, not law. A human reads and decides. Scorecard is immutable; if a claim is wrong, it's traceable.

**R3: Feedback loop degeneracy — template changes compound errors.**  
*Mitigate:* Changes are manual (human review + commit). Improvements are tagged (enabling trend measurement). Run a few baseline tasks post-change to confirm improvement before iterating again.

**R4: Cost of running analysis tasks.**  
*Mitigate:* 4 read-only agents is cheap (~$0.30–0.50 per analysis). Batch infrequently (e.g., every 5 tasks or weekly, not after every task).

---

## Future Directions (Out of MVP Scope)

- **Scheduled batches:** "Every Friday, auto-run feedback on tdd-build last 5 tasks."
- **Multi-perspective synthesis:** A "learner" agent reads all 3 + reviewer findings and writes a narrative ("here's what we learned").
- **Template A/B testing:** Run two template variants on the same task; analysis task compares them.
- **Code audit personas:** Extend to analyze landed code (shortcuts, test coverage, complexity).
- **Automated patch suggestion:** Reviewer proposes a `templates/tdd-build.yaml.patch` file for human review + merge.

---

## Success Criteria (Post-MVP Calibration)

- Reviewer's GOLD findings are actionable and at least 70% correct (measured by human review + improvement trends).
- Consensus patterns are reproducible across multiple feedback batches.
- Template changes guided by analysis tasks measurably reduce mistake-class rates in follow-up runs.

---

## Implementation Checklist (Future)

- [ ] Schema: add `role: "analysis"` and `analyze:` block to session-schema.ts.
- [ ] Data manifest: supervisor constructs a list of available artifacts (with paths or inline) for each input task.
- [ ] Supervisor fork: new path in supervisor logic for feedback runs; routes agent dispatch based on role.
- [ ] Agent dispatch: pre-load agents with data according to defaults (Cost Auditor: scorecard; Spec Finder: decision; Friction Detector: full JSONL). Provide manifest to all agents.
- [ ] Request handling: agents can request additional data; supervisor streams it or cites unavailability.
- [ ] System prompts: finalize 3 worker + 1 reviewer personas with explicit examples and data-access guidance.
- [ ] Finalization: write `verified-findings.md` (reviewer's output), noting which data sources each finding cites.
- [ ] E2E test: run a feedback task on 2–3 real runs; verify data manifest, reviewer ground-checks, confidence ranking.
- [ ] Documentation: add feedback-task template + examples to templates/.
- [ ] Improvements format: extend `quality/improvements.json` to include `template`, `personas`, and `measurement_method` fields.

---

**Next:** Feed this design to `/skill:to-spec` to formalize into tickets/stories.
