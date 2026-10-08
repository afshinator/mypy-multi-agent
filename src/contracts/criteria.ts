/**
 * The reviewer's per-criterion verdicts — the machine-checkable part of "done".
 * Shared by the A2A RESPONSE payload (reviewer -> supervisor), the finalize gate,
 * and the peer-side parser that extracts the fenced JSON block from a reply.
 */
import { z } from "zod";

export const CriterionVerdictSchema = z.strictObject({
  criterion: z.string().min(1),
  result: z.enum(["pass", "fail"]),
  evidence: z.string(),
});

export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

const FENCED = /```json\s*([\s\S]*?)```/i;

/**
 * Extract `[{criterion, result, evidence}]` from a fenced ```json block in a
 * reply. Accepts either a bare array or `{ "criteria": [...] }`. Returns
 * undefined when the block is absent or does not match the schema.
 */
export function parseCriteriaBlock(text: string): CriterionVerdict[] | undefined {
  const match = FENCED.exec(text);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? "");
  } catch {
    return undefined;
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { criteria?: unknown }).criteria;
  const result = z.array(CriterionVerdictSchema).safeParse(arr);
  return result.success ? result.data : undefined;
}
