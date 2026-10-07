/**
 * Single authority for the session phase (ACTIVE/FINALIZING/COMPLETE/ABORTED);
 * every gate reads this one instance.
 */
export type SessionPhase = "ACTIVE" | "FINALIZING" | "COMPLETE" | "ABORTED";

/**
 * Single authority for session-level state. Only control/finalization code
 * calls the mutators; every reader observes the same instance.
 */
export class SessionState {
  private phase: SessionPhase = "ACTIVE";

  get current(): SessionPhase {
    return this.phase;
  }

  get isActive(): boolean {
    return this.phase === "ACTIVE";
  }

  get isFinalizing(): boolean {
    return this.phase === "FINALIZING";
  }

  enterFinalizing(): void {
    if (this.phase === "ACTIVE") {
      this.phase = "FINALIZING";
      return;
    }
    if (this.phase === "FINALIZING") return;
    throw new Error(`cannot enter FINALIZING from ${this.phase}`);
  }

  complete(): void {
    if (this.phase !== "FINALIZING") throw new Error(`cannot complete from ${this.phase}`);
    this.phase = "COMPLETE";
  }

  abort(): void {
    this.phase = "ABORTED";
  }

  acceptsNewWork(): boolean {
    return this.phase === "ACTIVE";
  }

  canReactivate(): boolean {
    return this.phase === "ACTIVE";
  }
}
