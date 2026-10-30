/**
 * Maps one session agent into the config file handed to its headless peer, and
 * the pi tool set implied by its permissions.
 */
import { join } from "node:path";
import { endpointFromBusPath, type PeerEndpoint } from "../bus/peer-link";
import type { SessionConfig } from "../contracts/session-schema";

export interface PeerPermissions {
  read: boolean;
  edit: boolean;
  shell: boolean;
}

export interface PeerConfig {
  agentId: string;
  title: string;
  model: string;
  systemPrompt: string;
  permissions: PeerPermissions;
  maxCostUsd: number;
  maxTokens?: number;
  shellAllowlist?: string[];
  shellDeny?: string[];
  busPath: string;
  /**
   * How this peer reaches the bus. Written beside `busPath` so a non-unix
   * transport needs no new argv; a peer with no descriptor dials `busPath`.
   */
  endpoint?: PeerEndpoint;
  /**
   * The run's run-details dir. The peer logs tool calls here, never beside the
   * socket: a long run path moves the socket to the OS temp dir, where every run
   * on the machine would share one tool-calls.jsonl.
   */
  runDetailsDir: string;
  workspaceRoot: string;
  retryPauseMs: number;
  retryMaxRetries: number;
  /** A5 stall threshold in ms; `0` disables the STALLED display label. */
  stallTimeoutMs: number;
  /** Issue #133: the runtime's lock acquire bound; the peer waits this + margin. */
  lockAcquireTimeoutMs: number;
}

export function toPeerConfig(
  agent: SessionConfig["agents"][number],
  busPath: string,
  workspaceRoot: string,
  policy: {
    pauseMs: number;
    maxRetries: number;
    stallTimeoutMs: number;
    lockAcquireTimeoutMs: number;
  },
  runDetailsDir: string,
): PeerConfig {
  return {
    agentId: agent.id,
    title: agent.title,
    model: agent.model,
    systemPrompt: agent.system_prompt,
    permissions: {
      read: agent.permissions.read,
      edit: agent.permissions.edit,
      shell: agent.permissions.shell,
    },
    maxCostUsd: agent.max_cost_usd,
    maxTokens: agent.max_tokens,
    shellAllowlist: agent.shell_allowlist,
    shellDeny: agent.shell_deny,
    busPath,
    endpoint: endpointFromBusPath(busPath),
    runDetailsDir,
    workspaceRoot,
    retryPauseMs: policy.pauseMs,
    retryMaxRetries: policy.maxRetries,
    stallTimeoutMs: policy.stallTimeoutMs,
    lockAcquireTimeoutMs: policy.lockAcquireTimeoutMs,
  };
}

/**
 * Issue #134: the stall deadline one agent runs under. A free-class slug
 * (catalog price 0) gets `session.free_class_stall_timeout_ms` — it can sit
 * silent for minutes before its first tool call — while a priced slug keeps
 * `session.stall_timeout_ms`. `0` disables the class override. Pure: the
 * runtime uses this for both the peer config it writes and its own stall scan,
 * so the label the peer shows and the AGENT_STALLED timing can never diverge.
 */
export function stallTimeoutForAgent(
  agent: Pick<SessionConfig["agents"][number], "model">,
  session: Pick<SessionConfig["session"], "stall_timeout_ms" | "free_class_stall_timeout_ms">,
  isFreeModel: (model: string) => boolean,
): number {
  const freeClass = session.free_class_stall_timeout_ms;
  return isFreeModel(agent.model) && freeClass > 0 ? freeClass : session.stall_timeout_ms;
}

/**
 * Where the peer appends its tool-call log. Derived from the run dir, never from
 * the socket path: `resolveSocketPath` relocates the socket to the OS temp dir
 * when the run path is long, and the runtime and scorecard read this file from
 * `run-details/`.
 */
export function peerToolLogPath(cfg: Pick<PeerConfig, "runDetailsDir">): string {
  return join(cfg.runDetailsDir, "tool-calls.jsonl");
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
