/**
 * Whether the run changed code. markChanged() is triggered by an inbound
 * INTENT_TO_MODIFY envelope, which a peer emits (change-notifier.ts) the first
 * time an `edit`, `write` or `bash` tool call succeeds — bash included, because
 * a peer can rewrite files through `sed -i` or a redirect (#29).
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
