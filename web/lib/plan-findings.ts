import type { DirReader } from "./discovery";

/** Typed plan/findings document; each field is null when its file is absent. */
export interface PlanFindings {
  plan: string | null;
  findings: string | null;
}

/** Load plan.md/findings.md through the reader into a typed aggregate. */
export async function loadPlanFindings(
  reader: DirReader,
  runDetailsPath: string,
): Promise<PlanFindings> {
  const [plan, findings] = await Promise.all([
    reader.readText(`${runDetailsPath}/plan.md`),
    reader.readText(`${runDetailsPath}/findings.md`),
  ]);
  return { plan: plan?.text ?? null, findings: findings?.text ?? null };
}
