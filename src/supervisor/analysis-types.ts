/**
 * Types for the analysis task type.
 *
 * An analysis task points at previously completed runs and produces a
 * post-mortem. Analysts are peers: they read the run directories themselves
 * and return prose in FINAL_REPORT.report (a string — see a2a-schema.ts:119).
 * Nothing here parses or validates that prose; the reviewer reads it.
 */

/** One artifact present in a run directory. */
export interface RunArtifact {
  name: string;
  path: string;
  bytes: number;
}

/** A resolved run directory handed to the analysts. */
export interface AnalysisTarget {
  id: string;
  run_details_dir: string;
  artifacts: RunArtifact[];
  /** Expected artifacts that are absent. Analysts are told about these. */
  missing: string[];
}

/**
 * Analyst identities. Fixed by the task type, not configurable: each one is a
 * different lens on the same evidence, and the cross-check depends on their
 * independence.
 */
export type AnalystId = "cost" | "spec" | "friction";

export interface AnalystReport {
  analyst: AnalystId;
  report: string;
}

/** A report that never arrived. Recorded, never silently dropped. */
export interface AnalystFailure {
  analyst: AnalystId;
  error: string;
}

export interface AnalysisReports {
  targets: AnalysisTarget[];
  success_criterion: string;
  analysts: AnalystReport[];
  reviewer?: { report: string };
  failures?: AnalystFailure[];
}
