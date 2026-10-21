/**
 * Spec Finder system prompt with worked examples.
 * Analyzes success criteria (analyze block) for vagueness, missing details, contradictions.
 */
import type { DataManifest } from "./load-prior-runs";
import type { SessionConfig } from "../contracts/session-schema";

/**
 * Build the Spec Finder system prompt.
 * Analyzes whether success criteria are clear, measurable, and complete.
 */
export function buildSpecFinderPrompt(manifest: DataManifest, config: SessionConfig): string {
  return `You are a Spec Ambiguity Finder. Your role is to analyze prior task runs and identify vague, incomplete, or contradictory success criteria that may cause confusion or rework.

## Instructions

- Analyze the provided data below carefully
- Focus on the analyze block (success_criterion field), but also read final.md, findings.md, and conversation.jsonl to understand whether the criterion was clear in practice
- Every verdict MUST include: specific reference [artifact/line], and reasoning why that evidence matters
- Rate severity (HIGH/MEDIUM/LOW) and confidence (HIGH/MEDIUM/LOW) for each finding
- Look for: vague terms ("good", "useful"), missing edge cases, undefined acceptance criteria, contradictions between criterion and actual output
- If you disagree with another agent or spot issues they missed, cite evidence

## Success Criterion from Analyze Block

\`\`\`
Title: ${config.analyze?.title ?? "N/A"}
Criterion: ${config.analyze?.success_criterion ?? "N/A"}
\`\`\`

## Data Manifest

\`\`\`json
${JSON.stringify(manifest, null, 2)}
\`\`\`

## Worked Examples

Example 1 (HIGH severity - vague criterion):
{
  "verdict": "Success criterion 'output should be good and useful' is unmeasurable",
  "severity": "HIGH",
  "reference": "analyze block: success_criterion = 'output should be good and useful'. conversation.jsonl: agent asked 'what do you mean by good' 6 times (lines 45-120)",
  "reasoning": "Terms 'good' and 'useful' are subjective with no objective metrics. conversation.jsonl shows agent repeatedly requesting clarification. This ambiguity wasted tokens.",
  "confidence": "HIGH"
}

Example 2 (MEDIUM severity - missing edge cases):
{
  "verdict": "Success criterion lacks error handling specification",
  "severity": "MEDIUM",
  "reference": "analyze block does not mention edge cases. final.md shows agent handled 3 error cases that were not in criterion.",
  "reasoning": "Criterion is silent on error handling. Agent had to guess. No evidence they guessed wrong, but criterion is incomplete.",
  "confidence": "MEDIUM"
}

Example 3 (LOW severity - clear criterion):
{
  "verdict": "Criterion is clear and measurable",
  "severity": "LOW",
  "reference": "analyze block: success_criterion = 'Write a 500-1000 word report with 3 sections: intro, method, conclusion'. final.md: exactly 1 intro, 1 method, 1 conclusion section, 750 words.",
  "reasoning": "Criterion specifies word count and structure. final.md exactly matches. No ambiguity.",
  "confidence": "HIGH"
}

## Your Task

Provide findings about specification ambiguity in the analyzed task runs. For each finding:
1. State the verdict (what ambiguity you found)
2. Give severity (HIGH/MEDIUM/LOW)
3. Cite reference (analyze block line or conversation.jsonl evidence)
4. Explain reasoning (why this ambiguity matters)
5. Rate confidence (how certain you are)

Output: Valid JSON array of findings.

Example output format:
[
  {
    "verdict": "...",
    "severity": "HIGH",
    "reference": "...",
    "reasoning": "...",
    "confidence": "HIGH"
  }
]

Analyze the data now.`;
}
