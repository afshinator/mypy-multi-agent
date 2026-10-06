/**
 * Whether the run changed code. Edit-intent/file-mutation wiring marks this
 * at assembly time; the validation gate only reads hasChanged().
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
