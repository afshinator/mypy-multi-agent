# Feedback-Workshop Implementation Spec

**Status:** Formal spec, ready for GitHub issues.

**Source:** Generated from feedback-workshop-design.md via `/skill:to-spec`.

---

## Phase 1: Config Schema + Supervisor Logic

### Config Schema: Session with feedback-workshop Role

**Description:**  
Extend `session-schema.ts` to support `role: "feedback-workshop"` and add `analyze:` block for metadata. Supervisor logic must branch on `role` to skip normal task dispatch and route to feedback-workshop orchestration instead.

**Acceptance Criteria:**
- [ ] `session.role` field added to session schema with enum: `"standard" | "feedback-workshop"`
- [ ] `analyze:` block schema defined with fields: `title`, `template_target` (optional), `success_criterion`
- [ ] `session.input_tasks` accepts array of relative paths (e.g., `"../04-inspector-server/"`)
- [ ] Schema validation passes for both standard and feedback-workshop roles
- [ ] Existing standard runs still pass validation (backward compatibility)
- [ ] Supervisor code branches on `role` value; feedback-workshop branch identified but dispatch deferred to Phase 2

**Dependencies:** None (schema-only)

**Effort:** S

---

### Supervisor: Load & Curate Phase

**Description:**  
Supervisor reads input task paths, extracts artifacts from each (final.md, scorecard.json, findings.md, decision record, optional JSONL excerpts), and prepares a **data manifest** listing what's available for each task. Error handling for missing artifacts.

**Acceptance Criteria:**
- [ ] Supervisor resolves all relative paths in `session.input_tasks` to absolute paths
- [ ] For each input task, supervisor reads:
  - `final.md` (frontmatter + decision record)
  - `scorecard.json` (if exists)
  - `findings.md` (if exists)
  - Stores metadata (task name, run date, cost, turn count from scorecard frontmatter)
- [ ] Missing artifacts are logged; available artifact manifest is recorded per-task
- [ ] Supervisor validates at least N tasks exist (recommend N ≥ 2, enforce N ≤ 20 to keep cost bounded)
- [ ] Data manifest JSON output written to `run-details/data-manifest.json` for later reference
- [ ] Supervisor decision record notes artifact availability per task

**Dependencies:** Config Schema ticket

**Effort:** M

---

### Supervisor: Dispatch Workers Phase

**Description:**  
Supervisor spawns 3 worker agents (cost-auditor, spec-finder, friction-detector) in parallel, each with their persona's default data pre-loaded and manifest available for additional data requests.

**Acceptance Criteria:**
- [ ] Supervisor creates 3 agents with correct role IDs: `"cost-auditor"`, `"spec-finder"`, `"friction-detector"`
- [ ] Cost Auditor agent receives (pre-loaded):
  - `scorecard.json` from all input tasks
  - `final.md` frontmatter (cost breakdown) from all input tasks
  - Data manifest (enabling optional requests for conversation.jsonl, tool-calls.jsonl)
- [ ] Spec Finder agent receives (pre-loaded):
  - `final.md` decision record from all input tasks
  - `findings.md` from all input tasks
  - Data manifest (enabling optional requests)
- [ ] Friction Detector agent receives (pre-loaded):
  - `conversation.jsonl` (full transcript) from all input tasks
  - `findings.md` from all input tasks
  - `final.md` decision record + scorecard.json frontmatter
  - Data manifest (enabling optional requests for tool-calls.jsonl)
- [ ] All agents receive data manifest with artifact paths and availability status
- [ ] All agents receive explicit prompt: "You can request additional data by asking; supervisor will provide or cite unavailability"
- [ ] Agents are dispatched with read-only permissions (no shell, no edit)
- [ ] Supervisor waits for all 3 agents to complete before proceeding

**Dependencies:** Config Schema, Supervisor Load & Curate Phase

**Effort:** M

---

## Phase 2: Agent Dispatch + Data Manifest

### Data Manifest: Schema & Construction

**Description:**  
Formalize data manifest structure: list of available artifacts per input task, with file paths, availability status, and size (for agent awareness). Manifest is immutable (read-only to agents).

**Acceptance Criteria:**
- [ ] Manifest schema defined as JSON with fields per task:
  - `task_id` (e.g., "04-inspector-server")
  - `run_path` (absolute path to run-details/)
  - `artifacts`: map of artifact name → {available: bool, path: string, size_bytes: int, optional: bool}
  - `scorecard_frontmatter` (extracted cost, turns, errors, date)
- [ ] Manifest includes flags for large files (e.g., "conversation.jsonl too large; excerpt available on request")
- [ ] Manifest is serialized and passed to all agents as structured JSON (not in system prompt)
- [ ] Supervisor validates manifest schema before dispatch
- [ ] Manifest is versioned (e.g., `manifest_version: 1.0`) for future compatibility

**Dependencies:** Supervisor Load & Curate Phase

**Effort:** S

---

### Agent Request Handling: Additional Data Access

**Description:**  
Agents can request additional data beyond pre-loaded defaults (e.g., "give me conversation.jsonl for task-2 to verify the turn-duration claim"). Supervisor fulfills requests synchronously or cites unavailability.

**Acceptance Criteria:**
- [ ] Agents can include structured requests in findings (e.g., `[REQUEST: conversation.jsonl from task-2]`)
- [ ] Supervisor intercepts requests and:
  - Checks manifest for availability
  - Streams data if available (full or excerpt)
  - Logs request + fulfillment in decision record
  - Cites unavailability with reason if not available
- [ ] Request/fulfillment is recorded in supervisor decision record for reviewer's data-traceability check
- [ ] Maximum request size enforced (e.g., no more than 500KB per request) to control cost
- [ ] Requests block agent until fulfilled or denied (supervisor handles synchronously)

**Dependencies:** Data Manifest schema, Supervisor Dispatch Phase

**Effort:** M

---

### Agent: Cost Auditor Persona & Findings

**Description:**  
Finalize Cost Auditor system prompt with concrete examples. Agent analyzes scorecard data across input tasks, identifies spending anomalies, and outputs structured findings.

**Acceptance Criteria:**
- [ ] System prompt includes:
  - Role definition (spending analyst)
  - Concrete examples (e.g., "if phase 2 is consistently 60% of total budget, recommend splitting agent or increasing allocation")
  - Instructions to cite scorecard values (not speculate)
  - Output format: one finding per section, each with symptom, evidence, recommendation
- [ ] Cost Auditor findings include:
  - Per-phase token allocation anomalies
  - Per-agent budget burn patterns
  - Token waste indicators (retries, empty outputs, re-dispatches)
  - Recommendation with actionable template change (e.g., "increase max_tokens for implementer from 8000 to 12000")
- [ ] Findings are written to `run-details/cost-auditor-findings.md`
- [ ] Each finding is self-contained (no forward references to other agents)

**Dependencies:** Phase 1 Config Schema + Supervisor Load & Curate

**Effort:** M

---

### Agent: Spec Ambiguity Finder Persona & Findings

**Description:**  
Finalize Spec Ambiguity Finder system prompt. Agent analyzes decision records and DoD criteria for vague language, scope creep, and re-dispatch patterns.

**Acceptance Criteria:**
- [ ] System prompt includes:
  - Role definition (spec clarity analyst)
  - Concrete examples (e.g., "if supervisor re-dispatches on the same criterion twice, criterion is likely vague")
  - Instructions to cite decision-record quotes, re-dispatch counts, scope changes
  - Output format: one finding per section, each with vague criterion/pattern, evidence, recommendation
- [ ] Spec Finder findings include:
  - Ambiguous DoD criteria (with re-dispatch evidence)
  - Scope creep signals (supervisor reversals, feature additions not in plan)
  - Missing checkpoints (supervisor invented verification mid-run)
  - Recommendation with specific rewording or out-of-scope markers
- [ ] Findings are written to `run-details/spec-finder-findings.md`
- [ ] Each finding cites decision-record line numbers or quotes

**Dependencies:** Phase 1 Config Schema + Supervisor Load & Curate

**Effort:** M

---

### Agent: UX Friction Detector Persona & Findings

**Description:**  
Finalize Friction Detector system prompt. Agent analyzes conversation flow, peer findings, and supervisor notes for prompt clarity issues and agent confusion.

**Acceptance Criteria:**
- [ ] System prompt includes:
  - Role definition (UX/prompt clarity analyst)
  - Concrete examples (e.g., "if multiple agents ask the same clarifying question, prompt is context-sparse")
  - Instructions to cite peer findings, supervisor notes, conversation excerpts (with line numbers if available)
  - Output format: one finding per section, each with confusion type, evidence, recommendation
- [ ] Friction Detector findings include:
  - Patterns of repeated clarifying questions (signal: prompt too generic)
  - Agent scope misalignment (supervisor notes vs. spec; e.g., "implementer tried feature X when plan said no X")
  - Turn bloat (turns get longer over time; suggests agent backtracking)
  - Recommendation with prompt rewording or scope-boundary clarification
- [ ] Findings are written to `run-details/friction-detector-findings.md`
- [ ] Each finding includes specific prompt text or decision-record quote

**Dependencies:** Phase 1 Config Schema + Supervisor Load & Curate

**Effort:** M

---

## Phase 3: System Prompts

### System Prompts: Finalization & Example-Driven Refinement

**Description:**  
Refine all 4 system prompts (3 workers + reviewer) with concrete examples, output format specifications, and explicit data-access instructions. Validate against signal noise risk.

**Acceptance Criteria:**
- [ ] Cost Auditor prompt:
  - Includes 2–3 worked examples
  - Explicit instruction: "Do not speculate about causes"
  - Output format specified
- [ ] Spec Finder prompt:
  - Includes 2–3 worked examples
  - Explicit instruction: "Vagueness is only real if you find evidence"
  - Output format specified
- [ ] Friction Detector prompt:
  - Includes 2–3 worked examples
  - Explicit instruction: "Confusion patterns require multiple signals"
  - Output format specified
- [ ] Reviewer prompt:
  - Includes 2–3 worked examples
  - Explicit grounding instructions: YES/PARTIAL/NO
  - Confidence label guidance: GOLD/SILVER/BRONZE
  - Output format specified
- [ ] All prompts include instruction: "You have a data manifest. Request additional data explicitly: [REQUEST: artifact_name from task_id]"
- [ ] Prompts reviewed for clarity and hallucination risk before dispatch

**Dependencies:** Agent personas tickets

**Effort:** M

---

### Reviewer Agent: Dispatch & Ground-Check Logic

**Description:**  
Supervisor dispatches Reviewer agent after all 3 workers complete. Reviewer receives all findings + full data manifest, performs ground-check and confidence ranking, and outputs reconciled findings.

**Acceptance Criteria:**
- [ ] Reviewer is dispatched only after all 3 worker agents return (blocking wait in supervisor)
- [ ] Reviewer receives (pre-loaded):
  - All 3 worker findings
  - Full data manifest
  - Full scorecard.json values
  - final.md decision records from all input tasks
- [ ] Reviewer performs for each finding:
  - **Ground-check:** Verify claim against available data (YES/PARTIAL/NO)
  - **Conflict detection:** Align with other agents or contradict?
  - **Data traceability:** Which data sources did agent access?
  - **Confidence ranking:** GOLD / SILVER / BRONZE
  - **Impact assessment:** Does this solve the problem?
- [ ] Reviewer output: `verified-findings.md` with:
  - Finding title + confidence level
  - Original agent ID
  - Claim restatement
  - Evidence cited
  - Ground-check result
  - Conflict notes
  - Data traceability
  - Impact narrative
  - Recommendation
- [ ] Findings ranked by confidence + impact (descending)
- [ ] Conflicts arbitrated with evidence

**Dependencies:** All 3 worker agent tickets, System Prompts refinement

**Effort:** L

---

## Phase 4: Finalization + Output Format

### Supervisor: Finalization & Recommendation Ranking

**Description:**  
After Reviewer completes, supervisor reconciles all findings, writes final.md with recommendation priorities, and compiles findings summary for human review.

**Acceptance Criteria:**
- [ ] Supervisor waits for Reviewer to complete before finalizing
- [ ] Supervisor reads verified-findings.md and extracts: GOLD, SILVER, BRONZE findings
- [ ] Supervisor writes `run-details/final.md` with:
  - Frontmatter: run ID, role, date, input tasks, success_criterion
  - Decision Record: supervision summary
  - Recommendation Priorities: GOLD findings ranked by impact
  - Divergences: conflicts + arbitration
  - Success Verdict: pass/fail on success_criterion
- [ ] Supervisor creates `run-details/findings-summary.md` (human-readable one-pager):
  - List of GOLD findings with recommended template changes
  - List of SILVER findings for optional follow-up
  - List of BRONZE findings
  - Key conflicts + arbitration
- [ ] No agent output is lost; all 3 worker findings remain for audit trail
- [ ] Success criterion pass/fail is clear and deterministic

**Dependencies:** Reviewer dispatch ticket, all worker tickets

**Effort:** M

---

### Output Format: Verified Findings & Recommendations

**Description:**  
Standardize output files and ensure human reviewers can quickly extract actionable template changes.

**Acceptance Criteria:**
- [ ] Output files in run-details/:
  - `data-manifest.json`
  - `cost-auditor-findings.md`
  - `spec-finder-findings.md`
  - `friction-detector-findings.md`
  - `verified-findings.md`
  - `findings-summary.md`
  - `final.md`
- [ ] Each file includes metadata header (agent name, date, data sources)
- [ ] findings-summary.md includes "Recommended Template Changes" section with:
  - Priority (1, 2, 3...)
  - Confidence level (GOLD/SILVER/BRONZE)
  - Template file name
  - Change description
  - Evidence summary
- [ ] Findings de-duplicated (multiple workers recommend same change → merged)
- [ ] All recommendations include revert/rollback note

**Dependencies:** Supervisor Finalization ticket

**Effort:** S

---

### improvements.json Schema Extension

**Description:**  
Extend `quality/improvements.json` to track feedback-driven template changes, enabling measurement of whether changes reduce problem rates.

**Acceptance Criteria:**
- [ ] `quality/improvements.json` schema updated with fields:
  - `template` (e.g., "tdd-build.yaml")
  - `personas` (array: ["cost-auditor"] or ["spec-finder", "friction-detector"])
  - `measurement_method` (e.g., "measure M3 rate before/after")
  - `feedback_run_id`
  - `confidence` (GOLD/SILVER/BRONZE)
- [ ] Human review step populates improvements.json before landing commit
- [ ] Scorecard in follow-up runs can reference improvement record
- [ ] Documentation added to `docs/agents/` explaining flow

**Dependencies:** Output Format ticket

**Effort:** S

---

## Phase 5: E2E Test

### E2E Test: Feedback-Workshop Run on Real Tasks

**Description:**  
Run the complete feedback-workshop flow on 2–3 real task runs from the codebase. Validate data manifest construction, agent dispatch, reviewer grounding, and output format.

**Acceptance Criteria:**
- [ ] Test environment: 3 real task runs selected, artifacts confirmed present
- [ ] Test session.yaml created with role, input_tasks, template_target, success_criterion
- [ ] Feedback-workshop run executed: `/mypi-multi-agent feedback-batch-test`
- [ ] All 3 worker agents complete with findings (no errors, no timeouts)
- [ ] Reviewer agent completes with verified-findings.md
- [ ] Supervisor finalizes with final.md + findings-summary.md
- [ ] Validation:
  - Data manifest complete and accurate
  - Each worker finding non-empty and cites evidence
  - Reviewer ground-checks performed for every finding
  - ≥1 GOLD finding exists
  - Recommendations actionable
  - No hallucinations (human review confirms)
  - Cost < $2
  - success_criterion met

**Dependencies:** All Phase 1–4 tickets

**Effort:** L

---

### E2E Test: Output Audit & Human Readability

**Description:**  
Validate that output files are human-readable, complete, and suitable for template-change decision-making.

**Acceptance Criteria:**
- [ ] findings-summary.md readable in <5 minutes
- [ ] All GOLD findings have: clear problem, recommended change, evidence summary, expected impact
- [ ] No worker finding missing from verified-findings.md
- [ ] Reviewer ground-checks transparent
- [ ] Conflicts explained with evidence
- [ ] final.md success verdict clear
- [ ] Cost breakdown shows per-agent cost

**Dependencies:** Output Format ticket, E2E Test: Real Tasks

**Effort:** M

---

### Integration Test: Agent Request Handling

**Description:**  
Validate that agents can request additional data and supervisor fulfills requests correctly.

**Acceptance Criteria:**
- [ ] Test: Cost Auditor requests conversation.jsonl
  - Supervisor receives, checks manifest, streams data if available
  - Request logged in decision record
- [ ] Test: Spec Finder requests unavailable artifact
  - Supervisor checks manifest, responds with unavailability reason
  - Agent notes unavailability, continues
  - Reviewer sees agent did NOT access this artifact
- [ ] Test: Request size limit enforced
  - Supervisor denies/truncates large requests
  - Agent adapts and continues
- [ ] All requests/fulfillments logged with timestamps

**Dependencies:** Agent Request Handling ticket, E2E Test tickets

**Effort:** M

---

### Documentation: Feedback-Workshop Template & Examples

**Description:**  
Create user-facing documentation and template for running feedback-workshop tasks.

**Acceptance Criteria:**
- [ ] Template file `templates/feedback-workshop.yaml` with:
  - Example session.yaml
  - Annotated comments
  - Example input_tasks
  - Example success_criterion
- [ ] Documentation in `docs/`:
  - "Running a Feedback Workshop" guide
  - Output file meanings
  - GOLD/SILVER/BRONZE interpretation
  - Example workflow
  - Example commit message
- [ ] Glossary updates
- [ ] Examples directory:
  - `examples/feedback-workshop/session.yaml`
  - `examples/feedback-workshop/sample-findings-summary.md`

**Dependencies:** All tickets

**Effort:** S

---

### Post-Implementation: Measurement & Calibration

**Description:**  
Set up framework for measuring success of feedback-driven template changes (beyond MVP acceptance).

**Acceptance Criteria:**
- [ ] Baseline metrics defined and documented:
  - "70% human accuracy of GOLD findings"
  - "Consensus reproducibility" (same pattern in 2+ batches)
  - "Template change impact" (improvement in targeted metric)
- [ ] improvements.json records:
  - Baseline metric value
  - Expected improvement direction + magnitude
  - Measurement window
  - Result window
- [ ] Scorecard updated to include feedback metrics
- [ ] No implementation work; documentation/framework only

**Dependencies:** Supervisor Finalization, improvements.json Extension

**Effort:** S

---

## Risks & Mitigations

### R1: Signal Noise — Agents Hallucinate Patterns
**Risk:** Workers agree on a pattern that doesn't exist.  
**Mitigation:**
- Persona prompts explicitly forbid speculation
- Reviewer ground-checks every claim (YES/PARTIAL/NO)
- Start with curated excerpts, not full logs
- Beta-test on 2–3 known-good batches; human review confirms all GOLD findings
- All findings in run-details/ for audit trail

### R2: False Consensus — All Agents Agree on Something Wrong
**Risk:** All 4 agents converge on incorrect conclusion.  
**Mitigation:**
- Reviewer is the human check; findings are a record, not law
- Scorecard is immutable; if change causes regression, commit is traceable and reversible
- improvements.json records expected impact; follow-up runs confirm/refute
- Recommend 2+ follow-up runs post-change to validate before iterating

### R3: Feedback Loop Degeneracy — Template Changes Compound Errors
**Risk:** Wrong change pollutes future runs.  
**Mitigations:**
- Template changes are manual (human review + commit)
- improvements.json enables trend measurement
- Each change includes revert note in commit
- Quarterly review of improvements.json to catch cumulative drift

### R4: Cost of Running Feedback Workshops
**Risk:** 4 agents adds overhead.  
**Mitigation:**
- Cost ceiling: ~$0.30–0.50 per workshop
- Batch infrequently (every 5 tasks or weekly, not after every task)
- Config includes `max_cost_usd: 2.00` hard limit
- E2E test validates cost assumption

### R5: Missing or Corrupted Input Task Artifacts
**Risk:** Missing final.md, scorecard, or conversation.jsonl breaks analysis.  
**Mitigation:**
- Data manifest explicitly lists available vs. unavailable artifacts
- Agent prompts: "If an artifact is unavailable, note it and proceed"
- Reviewer tracks which data each agent accessed; BRONZE findings rely on missing data
- Supervisor validates ≥2 of 3 input tasks have scorecard + decision record

---

## Open Questions Requiring Resolution Before Implementation

### Q1: Scope of Input Tasks — Variety Allowed?
**Question:** Can feedback batch include runs from different templates, or must all be from same template?  
**Impact:** Affects agent prompts and ranking comparability.  
**Recommended resolution:** MVP assumes single-template batches; `analyze.template_target` is mandatory. Future: multi-template support with agent normalization.

### Q2: Artifact Size Limits & Streaming
**Question:** For large JSONL files, should we:
- (A) Stream in full (risk: token overflow)
- (B) Truncate to first/last N lines (risk: miss middle context)
- (C) Provide index + on-demand excerpt fetching (complex)  
**Impact:** Affects agent data requests and supervisor streaming.  
**Recommended resolution:** MVP uses option B (first + last 100 lines); if agent needs specific excerpt, they request by line-number range.

### Q3: Handling Agent Disagreement — Tie-Breaking Rule
**Question:** If workers strongly disagree (2 vs. 1), what does Reviewer do?
- (A) Side with majority (vote)
- (B) Weigh evidence; majority doesn't matter
- (C) Flag as SILVER and defer to human  
**Impact:** Affects Reviewer prompt and confidence ranking.  
**Recommended resolution:** MVP uses option B; Reviewer is impartial judge grounded in evidence. If evidence is split, mark SILVER and explain disagreement.

### Q4: Data Request Blocking & Timeouts
**Question:** If agent requests data and supervisor can't fulfill, should:
- (A) Agent wait indefinitely
- (B) Supervisor timeout after N seconds
- (C) Agent check manifest first (no timeout risk)  
**Impact:** Affects supervisor dispatch and agent resilience.  
**Recommended resolution:** MVP uses option C + B; agent checks manifest first, but if still requests, supervisor times out after 10s with "artifact unavailable".

### Q5: Reviewer Depth — How Much Fact-Checking?
**Question:** Should Reviewer:
- (A) Verify claim exists in cited data (shallow)
- (B) Verify + check for contradictory data agent missed (deep)
- (C) Synthesize all three agents' data to find new patterns (very deep)  
**Impact:** Affects Reviewer prompt, time, and confidence calibration.  
**Recommended resolution:** MVP uses option A + light B; verify claim + check for contradictions, but don't synthesize. Future: add "learner" agent (out of scope).

### Q6: Success Criterion Operationalization
**Question:** If only 1 GOLD finding exists but criterion says "≥2 GOLD", should run:
- (A) Fail with exit code 1 (block)
- (B) Succeed but flag as "Partial" (allow review, no block)
- (C) Loop back and re-run workers (retry)  
**Impact:** Affects supervisor finalization and human flow.  
**Recommended resolution:** MVP uses option B; if criterion not met, final.md notes "Partial" and human decides whether to re-run. No retry logic.

### Q7: Template Change Impact Measurement
**Question:** How do we measure actual impact if the metric wasn't tracked in scorecard before?  
**Impact:** Affects measurability and feedback-loop closure.  
**Recommended resolution:** Human proposing change ALSO proposes the scorecard metric to track (e.g., "add M3 re-dispatch count"). Manual proposal, not automatic. Scorecard schema can be extended if metric is valuable.

---

**End of Spec**

Next Steps: Review with leadership. Once approved, assign Phase 1 & 2 tickets. Phase 3 (system prompts) in parallel with integration testing.
