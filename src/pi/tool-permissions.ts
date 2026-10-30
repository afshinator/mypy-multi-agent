/**
 * Permission shape plus the default-deny shell allowlist predicate. The
 * read/edit booleans are consumed by peer-config.ts (toolsForPermissions),
 * not by predicates here.
 */
export interface Permissions {
  read: boolean;
  edit: boolean;
  shell: boolean;
  shellAllowlist?: string[];
  /** Commands no segment may start with, whatever the other permissions say. */
  shellDeny?: readonly string[];
}

/**
 * True when any segment of `command` starts with a denied entry as a whole word.
 * Segments are split on `;`, `&&`, `||` and `|`, because the observed command
 * shape is `cd <dir> && npx vitest ...` — a plain prefix test would miss it.
 */
export function isDeniedShell(p: Permissions, command: string): boolean {
  const deny = p.shellDeny;
  if (deny === undefined || deny.length === 0) return false;
  return command.split(/&&|\|\||[;|]/).some((segment) => {
    const cmd = segment.trim();
    return deny.some((d) => cmd === d || cmd.startsWith(`${d} `) || cmd.startsWith(`${d}\t`));
  });
}

/**
 * Shell policy:
 * - shell off blocks everything;
 * - a denied command is blocked even when shell and edit are on (post-mortem-03
 *   rec 18: the peer that ran `npx` was edit-capable, so the allowlist, which is
 *   only materialized for `shell && !edit` peers, could not have stopped it);
 * - shell on + edit on allows anything else;
 * - shell on + edit off allows only the explicit allowlist (no inference).
 */
export function canShell(p: Permissions, command: string): boolean {
  if (!p.shell) return false;
  if (isDeniedShell(p, command)) return false;
  if (p.edit) return true;
  return (p.shellAllowlist ?? []).includes(command);
}
