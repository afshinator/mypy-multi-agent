/**
 * Whether the run changed code. markChanged() is triggered by an inbound
 * INTENT_TO_MODIFY envelope, which a peer emits (change-notifier.ts) the first
 * time an `edit` or `write` tool call succeeds. Mutations made through `bash`
 * do not arm it.
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
