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
}

/** Map one session agent into the config handed to its headless peer process. */
export function toPeerConfig(agent: SessionConfig["agents"][number], busPath: string): PeerConfig {
  return {
    agentId: agent.id,
    model: agent.model,
    systemPrompt: agent.system_prompt,
    permissions: { read: agent.permissions.read, edit: agent.permissions.edit, shell: agent.permissions.shell },
    maxCostUsd: agent.max_cost_usd,
    maxTokens: agent.max_tokens,
    shellAllowlist: agent.shell_allowlist,
    busPath,
  };
}

/**
 * Built-in pi tool names to enable for a peer, by permission.
 * shell:true + edit:false uses an allowlisted bash enforced at the tool layer (item 6),
 * so bash is not enabled here.
 */
export function toolsForPermissions(p: PeerPermissions): string[] {
  const tools = p.read ? ["read", "grep", "ls", "find"] : [];
  if (p.edit) tools.push("edit", "write");
  if (p.shell && p.edit) tools.push("bash");
  return tools;
}
