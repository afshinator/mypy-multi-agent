/**
 * Maps one session agent into the config file handed to its headless peer, and
 * the pi tool set implied by its permissions.
 */
import type { SessionConfig } from "../contracts/session-schema";

export interface PeerPermissions {
  read: boolean;
  edit: boolean;
  shell: boolean;
}

export interface PeerConfig {
  agentId: string;
  model: string;
  systemPrompt: string;
  permissions: PeerPermissions;
  maxCostUsd: number;
  maxTokens?: number;
  shellAllowlist?: string[];
  busPath: string;
  workspaceRoot: string;
}

/** Map one session agent into the config handed to its headless peer process. */
export function toPeerConfig(agent: SessionConfig["agents"][number], busPath: string, workspaceRoot: string): PeerConfig {
  return {
    agentId: agent.id,
    model: agent.model,
    systemPrompt: agent.system_prompt,
    permissions: { read: agent.permissions.read, edit: agent.permissions.edit, shell: agent.permissions.shell },
    maxCostUsd: agent.max_cost_usd,
    maxTokens: agent.max_tokens,
    shellAllowlist: agent.shell_allowlist,
    busPath,
    workspaceRoot,
  };
}

/**
 * Built-in pi tool names to enable for a peer, by permission.
 * shell:true enables bash for any edit level; command-level default-deny for the
 * shell allowlist is enforced by the permission-gate extension's tool_call hook.
 */
export function toolsForPermissions(p: PeerPermissions): string[] {
  const tools = p.read ? ["read", "grep", "ls", "find", "web_fetch"] : [];
  if (p.edit) tools.push("edit", "write");
  if (p.shell) tools.push("bash");
  return tools;
}
