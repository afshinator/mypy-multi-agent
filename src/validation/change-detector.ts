/**
 * Whether the run changed code. markChanged() is only triggered by an inbound
 * INTENT_TO_MODIFY envelope; peers currently edit via pi's tools and do not
 * emit one, so hasChanged() stays false until that wiring lands (see TODO.md).
 */
export class ChangeDetector {
  private changed = false;

  markChanged(): void {
    this.changed = true;
  }

  hasChanged(): boolean {
    return this.changed;
  }
}
