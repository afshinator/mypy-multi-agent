/**
 * Permission predicates for read/edit/shell, including the default-deny shell
 * allowlist (no command inference).
 */
export interface Permissions {
  read: boolean;
  edit: boolean;
  shell: boolean;
  shellAllowlist?: string[];
}

export function canRead(p: Permissions): boolean {
  return p.read;
}

export function canEdit(p: Permissions): boolean {
  return p.edit;
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
