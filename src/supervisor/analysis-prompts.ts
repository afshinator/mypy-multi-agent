/**
 * Work-order text for the analysis task type.
 *
 * The analysts' standing identity and finding contract live in the template
 * yaml (`agents[].system_prompt`) — that is the artifact a human or agent edits.
 * This module renders only what changes per run: which directories, what is in
 * them, and what this particular task is looking for.
 */

import { renderTargetInventory } from "./analysis-targets";
import type { AnalysisTarget, AnalystId, AnalystReport } from "./analysis-types";

export interface WorkOrderText {
  action: string;
  localDoD: string;
}

const LENS: Record<AnalystId, string> = {
  cost: `Your lens is cost and time. Where did the run spend money, tokens and wall
clock that did not buy progress? Look at token growth across turns, retries,
stalled or crashed agents, tool calls that repeat, and long turns with little
output. Distinguish our spending from the provider's behaviour.`,
  spec: `Your lens is the task definition. Did the run do the wrong work correctly?
Look for success criteria that could be read two ways, criteria that cannot be
checked, work orders that left the peer guessing, and scope that drifted without
anyone deciding it should. Quote the exact criterion or instruction you are
talking about.`,
  friction: `Your lens is the interaction. Where did the run waste turns talking
instead of working? Look for clarification loops, a peer re-asking what it was
already told, work handed back and forth, corrections that repeat, and any place
where a single well-placed instruction would have removed several turns.`,
};

function inventorySection(targets: AnalysisTarget[]): string {
  return `## Run directories to examine

Read these yourself; do not assume contents. Line counts and field names matter:
cite them.

${renderTargetInventory(targets)}

### If an artifact is listed as absent

spans.jsonl only exists on runs after tracing landed; older runs do not have it.
scorecard.json only exists on runs after the scorecard landed. When an artifact
is absent, use what is present (conversation.jsonl and tool-calls.jsonl carry the
turn structure; run-state.json carries the roster and totals) and say in your
report which evidence you used. Never state a number you did not read.`;
}

/** Wave 1: one work order per analyst. */
export function buildAnalystWorkOrder(
  targets: AnalysisTarget[],
  successCriterion: string,
  analyst: AnalystId,
): WorkOrderText {
  const action = `${LENS[analyst]}

${inventorySection(targets)}

## What this post-mortem is for

${successCriterion}

## How to report

Report findings in prose. For each finding, in this order:

1. **Observation** — what happened, with the artifact, line or span you read it
   from. "tool-calls.jsonl line 412: fixer-b repeated the same bash command
   four times, 0.9s apart" is an observation. "The agent was inefficient" is not.
2. **Interpretation** — why it matters, and whether we caused it. Say plainly
   when it is the provider's behaviour or the model's, not our configuration.
3. **Proposed reaction** — what to change. It may be a prompt, a DoD criterion,
   a model, a config field (max_tokens, max_cost_usd, stall_timeout_ms,
   peer_max_retries), or the shape of the work order. If nothing should change,
   say so and say why it is still worth recording.
4. **Confidence** — high, medium or low — and what would raise it.

Rules:
- A finding without a citation is not a finding. Drop it or go read the file.
- Do not propose a change you cannot connect to an observation.
- Do not report the same problem twice under two names.
- If you found nothing in your lens, say that plainly. An empty report is a
  valid result and is more useful than a padded one.`;

  return {
    action,
    localDoD: `Every finding cites an artifact and a location within it, states
whether the cause is ours, and proposes a reaction or explicitly says none is
warranted. No uncited claims.`,
  };
}

/** Wave 2: the reviewer, handed the three reports. */
export function buildReviewerWorkOrder(
  targets: AnalysisTarget[],
  successCriterion: string,
  reports: AnalystReport[],
): WorkOrderText {
  const reportSections = reports
    .map(
      (r) => `### ${r.analyst} analyst

${r.report}`,
    )
    .join("\n\n");

  const action = `Three analysts examined the same runs independently. Their reports
follow. You have the same directories available and are expected to check their
claims against the files, not against your impression of them.

${inventorySection(targets)}

## What this post-mortem is for

${successCriterion}

## The reports under review

${reportSections}

## What you must do

For each finding in each report, do three checks:

1. **Is the observation there?** Open the cited artifact at the cited location.
   If the evidence is absent, misread, or does not say what the analyst claims,
   say so and quote what is actually there.
2. **Does the interpretation overclaim?** "The provider is slow" and "the
   provider slowed after 40k tokens in 3 of 3 runs" are different claims. Hold
   the report to the second. Flag correlation asserted as cause.
3. **Does the proposed reaction address the observation?** A reaction that
   suppresses the symptom without touching the cause is worth naming as such.

Then:
- Name the findings you agree with and why.
- Name the ones you reject and what the artifact actually shows.
- Add findings the analysts missed, with the same citation requirement.
- Where two analysts describe the same underlying problem from different angles,
  say so — that agreement is the signal this review exists to find.

Report in prose, with citations. Do not rewrite their reports; respond to them.`;

  return {
    action,
    localDoD: `Every analyst finding is addressed (confirmed, corrected or rejected)
with an artifact citation. Disagreements are grounded in quoted evidence. At
least one cross-report observation is stated where the reports overlap.`,
  };
}
