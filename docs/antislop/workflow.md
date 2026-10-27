# Anti-slop pilot: execution contract

## 0. Status and prerequisites

`session.yaml` is an authoring template, **not a validated/runnable config yet**. This revision adds Ponytail, Fallow, and Biome as required evaluation candidates; the existing sample `session.yaml` may need changes after the repo-aware compatibility assessment.

Replace the three `REPLACE_PROVIDER/...` model IDs with real slugs from your model catalog and verify each with the guide's live probe. Run your project's strict Zod parser against the file. The guide, not this standalone deliverable, is the authority for syntax.

The task's `audit:collect` and `audit:verify` scripts **must be created or installed before launch**; their implementation is not supplied here. Also verify that the supervisor launches in the isolated worktree rather than the source repo.

## 1. Prepare a disposable audit checkout (outside the source repo)

1. Choose a source repository and record its `git rev-parse HEAD`; require clean tracked and untracked status, or explicitly record and exclude pre-existing modifications.
2. Create a **disposable detached git worktree** at a separate path at that commit. Never point the supervisor at the original checkout. Consider a separate clone for maximum isolation if tool installation can alter shared git metadata.
3. Keep an **audit-output** directory _outside_ the scanned worktree, with an absolute output path and write permissions reserved for tool outputs. Prevent tools from writing into source; use a container/FS sandbox if stronger guarantees are needed.
4. Inventory the **existing Ponytail skill, Fallow, and Biome** installations, configs, versions, and current workflow use. Independently verify the exact identity and capabilities of Ponytail and Fallow from the installed packages/skill files; do not infer them from names. Preinstall pinned versions of any additional analyzers and dependencies before launching agents. Keep pre-existing tool configs as the baseline, recording any audit-only overrides. Run checks only in non-fix mode. Disable telemetry/network and exclude generated/dist/vendor directories as appropriate. Package-manager installs and runtime hooks may execute arbitrary scripts: review their effects before provisioning.
5. Supply package scripts named `audit:collect` and `audit:verify` in the isolated copy only, or identify equivalent existing scripts during the compatibility assessment. The wrapper should set the explicit output path, invoke pinned analyzers and record all stdout/stderr and exit codes. Include `git status --porcelain` pre/post and a manifest/hash of included source files, not just git status.
6. Put `mypi-multi-agent.yaml` and `mypi-tasks/anti-slop-pilot/session.yaml` in the isolated checkout per the guide, or copy your existing `taskDirs` config. This changes only disposable audit infrastructure. Set `session.workspace_root` if the supervisor's cwd isn't the isolated checkout.

## 2. Tool evaluation matrix, pilot defaults

**Mandatory evaluation candidates: already used by this multi-agent system**
- **Ponytail (agent skill):** inspect its installed SKILL.md, supporting files, invocation model, scope, output format, and existing implementation-task usage. Determine whether it supports post-hoc repository auditing. If so, compare a Ponytail-guided AI reviewer with an unguided reviewer on equivalent modules, with separate prompts and findings. If it does not support audit invocation, record this as a limitation rather than pretending it is a deterministic analyzer. Its prevention effect on newly written code is a _later_ experiment.
- **Fallow:** inspect the actual installed version/configuration and verify its supported checks and output formats. Run its existing non-modifying checks; determine what findings overlap with Knip, jscpd, dependency-cruiser, or other analyzers **from observed results**, not inferred capabilities.
- **Biome:** run existing lint/check configurations in non-writing mode. Capture lint findings separately from formatting differences; explicitly disable any write/fix options. Compare the useful unique findings with Oxlint and/or typescript-eslint.

**Mandatory evaluation candidates: newly proposed**
- `tsc --noEmit`, where a usable tsconfig exists: correctness baseline, not an anti-slop score.
- **Knip:** unused files, exports, dependencies.
- **Oxlint** and/or **typescript-eslint** with type-aware rules: lint/type hazards and potential overlap with Biome.
- **aislop:** AI-pattern signal; capture detailed findings and any score, if supported by verified installed version.
- **dmmulroy/anti-slop:** opinionated TS rules. Verify repository identity, installation, and actual invocation before assigning results.
- **jscpd:** duplicated code; compare with any duplication detection offered by Fallow.
- **dependency-cruiser:** dependency structure/architecture checks; report where useful boundary policies are absent rather than inventing them.
- **Optional second wave:** Semgrep, CodeQL, other AI-based reviewers, only after the initial pilot is understood.

**No quiet exclusions.** Inventory all listed candidates and classify each as `executed`, `unsupported`, `not-installed`, `blocked`, or `deferred`, with a reason. Not every tool must successfully execute for the pilot to produce a useful report.

Preserve a comparison between the existing **Ponytail + Fallow + Biome** workflow and the added tools. In particular, calculate the _incremental verified findings_ contributed by each added analyzer beyond the existing baseline; do not equate high warning count with high value.

Before running any tool, verify the CLI/skill version, invocation, rule set, output format, and whether the command can write to disk.

For each executed tool capture: exact command or skill invocation, version/revision, config hash, status (`success_with_findings`, `clean`, `failure`, `timeout`, `unsupported`), duration, raw output paths, finding count, and whether findings are deterministic or model-judged.

**Do not use `--fix`, `--write`, or equivalent.** Treat Ponytail outputs as a separate AI-review dataset with model, prompt, and token-cost provenance.

## 3. Coordination sequence

1. Supervisor logs pinned commit, scope, planned commands, report path in `run-details/plan.md`.
2. Supervisor asks **auditor** to inspect selected modules _without seeing tool output_. For the Ponytail comparison, conduct matched independent review passes (unguided and Ponytail-guided) with clear separation and record model/prompt/sampling differences. If budget or capability prevents a fair comparison, label the result exploratory.
3. In parallel, runner executes the preprovisioned `bun run audit:collect` script to scan the existing-tool baseline and additional static analyzers. The runner should not touch application source files. Record every candidate that could not execute.
4. Supervisor obtains both first-pass reports, then gives analyzer output to auditor for comparison and investigates notable disagreements.
5. Verifier checks a stratified sample across tools (including Fallow and Biome), high severity, low confidence, overlapping rules, and random low-severity issues. It separately adjudicates AI-only findings from unguided and Ponytail-guided reviews. Distinguish `verified`, `false_positive`, `duplicate`, `inconclusive`.
6. Preprovisioned aggregation step creates `audit.json` and `audit.md`, including an existing-tools-vs-added-tools comparison and the Ponytail-vs-unguided AI review experiment. `audit:verify` checks schema and evidence references if implemented. The verifier checks final artifacts and attests the seven DoD strings verbatim.
7. Supervisor finalizes. A completed audit may legitimately contain hundreds of code findings. Failed/skipped tools must remain visible and must not be scored as clean.

## 4. Expected machine-readable report

```json
{
  "schema_version": "0.1",
  "repo_commit": "<full SHA>",
  "scope": {
    "included": ["src/**"],
    "excluded": ["dist/**", "node_modules/**"]
  },
  "tools": [
    {
      "id": "biome",
      "cohort": "existing",
      "version": "<pinned>",
      "status": "success_with_findings",
      "elapsed_ms": 1200,
      "raw_output": "raw/biome.json"
    },
    {
      "id": "knip",
      "cohort": "new",
      "version": "<pinned>",
      "status": "clean",
      "elapsed_ms": 1000,
      "raw_output": "raw/knip.json"
    }
  ],
  "findings": [
    {
      "id": "tool:rule:path:location",
      "tools": ["knip"],
      "path": "src/example.ts",
      "line": 10,
      "category": "unused_export",
      "severity": "low",
      "verification": "unreviewed",
      "evidence": "..."
    }
  ],
  "reviews": [
    {
      "id": "ponytail-review",
      "method": "skill_guided",
      "skill_revision": "<verified>",
      "model": "<verified>",
      "raw_output": "raw/ponytail-review.md"
    }
  ],
  "verification": {
    "sampling_method": "stratified",
    "sample_size": 0,
    "verified": 0,
    "false_positive": 0,
    "inconclusive": 0
  },
  "limitations": []
}
```

This is a **proposed schema**, not a built-in output of the multi-agent harness. It needs an aggregation script.

Keep raw findings and a separate normalized layer. Calculate precision **only on adjudicated findings** and identify sampling uncertainty; don't claim full-repository recall without a labeled defect set.

Density is useful when normalized to included production LOC, not generated/vendor LOC.

## 4a. Adjudication dimensions and blindness

Each finding is judged on three independent dimensions, recorded per (tool, rule family)
in `audit.json` as `verification.by_family`:
1. **Validity** — is the reported condition genuinely present? `present` / `absent` /
   `duplicate` / `undecidable`. Only `present` can carry the other two.
2. **Actionability** — would changing it materially improve the code? `material` /
   `marginal` / `none`.
3. **Consequence** — what does leaving it alone cost? `high` / `medium` / `low` / `none`.

A family adjudicated fewer than 5 times is reported as `anecdote`, never as a rate. The
pilot's single `verified` count conflated 75% valid with 22% actionable; the split is the
point of the change.

Blind the packet with `scripts/antislop/blind.ts`:

    bun scripts/antislop/blind.ts --findings <rows.json> --out <peer.json> --key <key.json> --salt <s>

Rows reach the adjudicator as `{id: salted hash, path, line, claim}`; the key joins back
afterwards and must not be in the peer's view. This removes _identity_ bias only — a rule
id embedded in an analyzer's message is redacted, but the family usually remains inferable
from the claim's own words, and a claim cannot be stripped without deleting what is being
judged.

## 5. Core measurement questions

- Which tool found unique, actionable issues confirmed by independent review, and how much does it add beyond the existing Ponytail/Fallow/Biome workflow?
- What proportion of sampled findings were false positives, duplicates, or subjective preferences?
- Which classes of problem were entirely missed by static tools but found by the auditor? Does Ponytail-guided review add verified findings over ordinary AI review on a matched sample?
- What is the verified-issue density per 1,000 included LOC, split by category and severity?
- How long and how much did each analyzer and LLM review cost, including the supervisor?

## 6. Safety and honesty checks

- No agents install, uninstall, or update tools during the audit; provisioning and cleanup happen before/after the agent session.
- `edit:false` and a restricted command allowlist prevent direct edit/write tool use but do **not** guarantee side-effect-free shell commands. Treat isolation as a property of the execution environment.
- Read permissions also expose `web_fetch`; the guide does not document a separate switch to disable it. If offline/private auditing is required, enforce network restrictions outside the agent harness.
- `validation.commands` is skipped in a no-edit run under the guide's current change detector. Therefore `audit:verify` must be run as an explicit work order and its result inspected by the verifier.
- `session.max_cost_usd` caps **peer spend only**; the supervisor's model cost is outside that runtime cap.
- A DoD pass means _the audit deliverables were produced and checked_, not that the repository is clean.

## 7. Pilot handoff and implementation boundary

The repo-aware agent must first provide a **compatibility assessment only**: inspect the actual multi-agent repository, installed Ponytail/Fallow/Biome setup, analyzer adapters, `session-schema.ts`, task directory conventions, and available command scripts.

Propose exact provisioning/invocations for the additional candidates, including unsupported tools and expected permission conflicts.

**Do not install tools, implement scripts, change framework code, or launch the audit until the user reviews that assessment.**

This execution contract and the sample `session.yaml` are starting proposals, not authority over the actual codebase. After approval, update the session config and scripts to match observed capabilities.
