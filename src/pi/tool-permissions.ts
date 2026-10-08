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
}

/**
 * Shell policy:
 * - shell off blocks everything;
 * - shell on + edit on allows anything;
 * - shell on + edit off allows only the explicit allowlist (no inference).
 */
export function canShell(p: Permissions, command: string): boolean {
  if (!p.shell) return false;
  if (p.edit) return true;
  return (p.shellAllowlist ?? []).includes(command);
}
