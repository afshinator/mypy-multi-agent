/**
 * The Finalize gate: the one owner of a run's success/failure decision.
 *
 * Folded out of Runtime (was Runtime.finalize/runFinalize/gateResult/citePath/
 * citedMtime/attesterReadTimes/captureCriteria). The pure term and citation
 * logic stays in supervisor/finalization.ts; this module owns the orchestration
 * (validation, run contract, citation resolution, artifact assembly) and the
 * attester-trust state. The interface is two phases — evaluate (decide) then
 * write (persist) — so a failed write never completes the session.
 */
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { FinalWriter } from "../artifacts/final-writer";
import type { CriterionVerdict } from "../contracts/criteria";
import type { SessionConfig } from "../contracts/session-schema";
import type { SessionState } from "../control/session-state";
import type { VerdictAdvisory } from "../jev/verdict-advisory";
import { readJsonl } from "../logging/conversation-log";
import {
  buildFinalization,
  type CostBreakdown,
  criteriaMismatches,
  criteriaSatisfied,
  type Finalization,
  type FinalSummary,
  type GateResult,
  gateResultFromTerms,
  staleCitations,
  toolReadTimes,
} from "../supervisor/finalization";
import type { Reconciliation } from "../supervisor/reconciliation";
import type { SpanHandle, Tracing } from "../tracing/tracing";
import { checkRunContract } from "../validation/run-contract";
import {
  runValidation,
  type ValidationResult,
  validationAllowsSuccess,
} from "../validation/validation-runner";

export interface FinalizeGateDeps {
  config: SessionConfig;
  workspaceRoot: string;
  runDetailsDir: string;
  askDir: string;
  session: SessionState;
  tracer: Tracing;
  currentSpan: () => SpanHandle | null;
  hasChanged: () => boolean;
  execValidation: (command: string) => Promise<boolean>;
  log: (entry: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  reconciliation: Reconciliation;
  now: () => number;
}

export class FinalizeGate {
  /** Latest attester verdict block; the gate trusts this, not the supervisor. */
  private peerCriteria: CriterionVerdict[] | undefined;
  /** When the attester's block was captured; 0 = none (so no staleness). */
  private criteriaAttestedAt = 0;
  /** Built in evaluate, consumed by write so the log and final.md share one outcome. */
  private finalization: Finalization | undefined;

  constructor(private readonly deps: FinalizeGateDeps) {}

  /** The verdict block the gate will use; read by the extension for the advisory. */
  get attestedCriteria(): CriterionVerdict[] | undefined {
    return this.peerCriteria;
  }

  /** Only the attester's block is trusted; anything else is logged and dropped. */
  captureVerdicts(agentId: string, criteria: CriterionVerdict[]): void {
    if (criteria.length === 0) return;
    const attester = this.deps.config.session.attester;
    if (agentId !== attester) {
      this.deps.log({
        type: "ERROR",
        timestamp: this.deps.now(),
        event: "non-attester-verdict",
        agentId,
        attester,
      });
      return;
    }
    // The instant this block was captured is what cited artifacts are compared
    // against at evaluate. Only the attester's block sets it — a non-attester's
    // would move the clock forward and hide a rewrite that landed after the
    // block the gate actually trusts.
    this.criteriaAttestedAt = this.deps.now();
    this.peerCriteria = criteria;
  }

  /**
   * Decide: the five terms (DoD asserted, criteria identity, stale-attestation,
   * validation, run contract) plus citation resolution. Pure of filesystem
   * writes except reading the tool-call log for read-times.
   */
  async evaluate(
    dodSatisfied: boolean,
    decision: string | undefined,
    summary: FinalSummary | undefined,
    advisory: VerdictAdvisory | undefined,
  ): Promise<GateResult> {
    const { deps } = this;
    const finalizeSpan = deps.tracer.startSpan("finalize", {
      parent: deps.currentSpan(),
      kind: "run-level",
      scopeId: null,
      agentId: null,
    });
    try {
      if (!deps.session.isFinalizing) deps.session.enterFinalizing();
      const validation = await runValidation(
        deps.config.validation,
        deps.hasChanged(),
        deps.execValidation,
        { tracer: deps.tracer, parent: finalizeSpan },
      );
      const attested = this.peerCriteria;
      const contract = checkRunContract(deps.runDetailsDir);
      if (!contract.ok) {
        deps.log({
          type: "ERROR",
          timestamp: deps.now(),
          event: "run-contract",
          missing: contract.missing,
        });
      }
      const readTimes = await this.attesterReadTimes();
      const stale = staleCitations(
        attested ?? [],
        this.criteriaAttestedAt,
        (p) => this.citedMtime(p),
        (p) => {
          // The read is recorded as the peer resolved it; a citation may be written
          // differently, so fall back to the locator's own resolution.
          const direct = readTimes.get(resolve(deps.workspaceRoot, p));
          if (direct !== undefined) return direct;
          const resolved = this.citePath(p);
          return resolved === undefined ? undefined : readTimes.get(resolved);
        },
      );
      if (stale.length > 0) {
        deps.log({
          type: "ERROR",
          timestamp: deps.now(),
          event: "stale-attestation",
          files: stale.map((s) => s.path),
        });
      }
      const result = this.gateResult(
        dodSatisfied,
        attested,
        validation,
        contract.ok,
        stale.length === 0,
      );
      for (const term of result.failingTerms) {
        deps.log({
          type: "ERROR",
          timestamp: deps.now(),
          event: "gate-rejected",
          term: term.name,
          ...(term.name === "criteria"
            ? { mismatches: criteriaMismatches(attested, deps.config.ask.definition_of_done) }
            : {}),
          ...(term.detail === undefined ? {} : { detail: term.detail }),
        });
      }
      // Build before logging so the FINALIZED entry and final.md share one
      // computed outcome instead of re-deriving it.
      this.finalization = buildFinalization(
        deps.reconciliation,
        result.success,
        decision,
        attested,
        summary,
        advisory,
      );
      deps.log({
        type: "FINALIZED",
        outcome: this.finalization.outcome,
        exitCode: this.finalization.exitCode,
        timestamp: deps.now(),
      });
      return result;
    } finally {
      deps.tracer.endSpan(finalizeSpan);
      if (deps.currentSpan()) deps.tracer.endSpan(deps.currentSpan() as SpanHandle);
    }
  }

  /** Persist final.md, then complete the session — only after the artifact exists. */
  async write(costs: CostBreakdown): Promise<void> {
    if (this.finalization === undefined) return;
    await this.deps.flush();
    await new FinalWriter(this.deps.runDetailsDir).write({
      ...this.finalization,
      costs,
    });
    this.deps.session.complete();
  }

  /** The ONE place where the run's success/failure decision lives. */
  private gateResult(
    dodSatisfied: boolean,
    attested: CriterionVerdict[] | undefined,
    validation: ValidationResult,
    contractOk: boolean,
    citationsFresh: boolean,
  ): GateResult {
    return gateResultFromTerms(
      dodSatisfied,
      criteriaSatisfied(attested, this.deps.config.ask.definition_of_done),
      citationsFresh,
      validationAllowsSuccess(validation),
      validation.status === "failed" ? validation.command : undefined,
      contractOk,
    );
  }

  /** Resolve a cited path against the workspace, then the run dirs, and stat it. */
  private citePath(path: string): string | undefined {
    const candidates = isAbsolute(path)
      ? [resolve(path)]
      : [
          resolve(this.deps.workspaceRoot, path),
          resolve(this.deps.runDetailsDir, path),
          resolve(this.deps.askDir, path),
        ];
    for (const candidate of candidates) {
      try {
        statSync(candidate);
        return candidate;
      } catch {
        // Try the next base; an unresolvable locator is not this check's verdict.
      }
    }
    return undefined;
  }

  /** The mtime of a cited path, once it resolves. */
  private citedMtime(path: string): number | undefined {
    const resolved = this.citePath(path);
    if (resolved === undefined) return undefined;
    try {
      return statSync(resolved).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /** When the attester last read each path, from the peer-written tool-call log. */
  private async attesterReadTimes(): Promise<Map<string, number>> {
    const entries = await readJsonl(join(this.deps.runDetailsDir, "tool-calls.jsonl"));
    return toolReadTimes(entries, this.deps.config.session.attester, (p) =>
      resolve(this.deps.workspaceRoot, p),
    );
  }
}
