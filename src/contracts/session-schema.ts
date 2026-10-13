/**
 * Session manifest contract: validates session.yaml (version/session/ask/agents/
 * bus/validation), enforces cross-field rules (unique agent ids, heartbeat
 * timing, shell allowlist), and derives defaults. Loaded by src/pi/extension.ts via
 * parseSessionConfig; the rest of the system consumes the `SessionConfig` type.
 */
import { z } from "zod";

const PermissionsSchema = z.strictObject({
  read: z.boolean(),
  edit: z.boolean(),
  shell: z.boolean(),
});

const AgentSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string(),
    model: z.string().min(1),
    capabilities: z.array(z.string()).optional(),
    limits: z.array(z.string()).optional(),
    permissions: PermissionsSchema,
    max_cost_usd: z.number().gt(0),
    max_tokens: z.number().int().gt(0).optional(),
    // RT-1: an unpriced model may run with no token cap; the operator must opt in
    // explicitly rather than be forced onto a quota it cannot reason about.
    allow_unbounded: z.boolean().optional(),
    system_prompt: z.string(),
    shell_allowlist: z.array(z.string()).optional(),
  })
  .superRefine((agent, ctx) => {
    if (agent.shell_allowlist !== undefined && agent.permissions.shell !== true) {
      ctx.addIssue({
        code: "custom",
        message: "shell_allowlist requires permissions.shell: true",
        path: ["shell_allowlist"],
      });
    }
  });

const JevSchema = z.strictObject({
  // Optional semantic advisory over the peer verdicts. Advisory only: recorded
  // in final.md, never part of the exit code (RT-8 D2; see docs/jev/).
  verdict_check: z.boolean().default(false),
  model: z.string().min(1).default("openrouter/typesafe/jev-1.13"),
  review_threshold: z.number().gt(0).lt(1).default(0.5),
});

const SessionSchema = z
  .strictObject({
    id: z.string().min(1),
    workspace_root: z.string().optional(),
    supervisor_system_prompt: z.string().optional(),
    supervisor_model: z.string().optional(),
    max_cost_usd: z.number().gt(0),
    agent_stop_threshold_percent: z.number().min(1).max(100),
    heartbeat_timeout_ms: z.number().int().gt(0).default(3000),
    finalization_grace_usd: z.number().gte(0).optional(),
    finalization_grace_ms: z.number().int().gte(0).default(30000),
    peer_retry_pause_ms: z.number().int().gte(0).default(30000),
    peer_max_retries: z.number().int().gte(0).default(3),
    peer_prompt_timeout_ms: z.number().int().gt(0).default(120000),
    // A5: emit AGENT_STALLED when an open turn reports no progress for this long
    // (0 disables). Default sits above the longest observed single tool (~2 min).
    stall_timeout_ms: z.number().int().gte(0).default(300000),
    // Pre-spawn model check: strict = abort, warn = notify and continue, off = skip.
    verify_models: z.enum(["strict", "warn", "off"]).default("warn"),
    // MT-3: a peer over its stop threshold finishes the current work order
    // before stopping instead of being cut off mid-task.
    stop_at_work_order_boundary: z.boolean().default(false),
    wall_clock_ms: z.number().int().gt(0).optional(),
    // The exact commands a read-only (shell:true, edit:false) peer may run.
    // Declared once and inherited by every such peer (RT-8 D1/F3).
    shell_vocabulary: z.array(z.string().min(1)).optional(),
    // RT-8 R10: the only agent whose verdict block the finalize gate trusts.
    // Required for every version: a missing or unknown attester is rejected.
    attester: z.string({ error: "session.attester is required — set attester: <agent-id>" }).min(1),
    jev: JevSchema.optional(),
  })
  .transform((s) => ({
    ...s,
    // Reserved: the grace fields are validated here but not yet consumed by
    // finalization (see docs/TODO.md). Default keeps 10% of the ceiling.
    finalization_grace_usd: s.finalization_grace_usd ?? s.max_cost_usd * 0.1,
  }));

const AskSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  // A list of checkable work criteria — "done" is these, nothing else. Output/process
  // requirements (branch, artifacts, headers, validation) are the system's run contract,
  // not the DoD.
  definition_of_done: z.array(z.string().min(1)).min(1),
});

const ValidationSchema = z.strictObject({
  commands: z.array(z.string()),
});

const BusSchema = z.strictObject({
  // Reserved: parsed but not yet consumed by the runtime (see docs/TODO.md).
  transport: z.string().optional(),
  socket_path: z.string().optional(),
  heartbeat_interval_ms: z.number().int().gt(0).default(1000),
});

const SessionConfigSchema = z
  .strictObject({
    version: z.string(),
    session: SessionSchema,
    ask: AskSchema,
    agents: z.array(AgentSchema).min(1),
    bus: BusSchema.optional(),
    validation: ValidationSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const agent of config.agents) {
      if (seen.has(agent.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate agent id "${agent.id}"`,
          path: ["agents"],
        });
      }
      seen.add(agent.id);
    }
    const interval = config.bus?.heartbeat_interval_ms ?? 1000;
    if (config.session.heartbeat_timeout_ms < interval * 2) {
      ctx.addIssue({
        code: "custom",
        message: "heartbeat_timeout_ms must be >= 2x heartbeat_interval_ms",
        path: ["session", "heartbeat_timeout_ms"],
      });
    }
    for (const agent of config.agents) {
      // RT-8 D1/F3: shell:true + edit:false runs only exact allowlist matches, so it
      // needs a non-empty set from its own allowlist or the session vocabulary.
      if (
        agent.permissions.shell === true &&
        agent.permissions.edit !== true &&
        (agent.shell_allowlist ?? config.session.shell_vocabulary ?? []).length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          message: `agents[].${agent.id}: permissions.shell: true with edit: false requires a non-empty shell_allowlist or session.shell_vocabulary`,
          path: ["agents"],
        });
      }
    }
    const attester = config.session.attester;
    if (!config.agents.some((a) => a.id === attester)) {
      ctx.addIssue({
        code: "custom",
        message: `session.attester "${attester}" is not a configured agent id — set attester: <agent-id>`,
        path: ["session", "attester"],
      });
    }
  })
  .transform((config) => ({
    ...config,
    // Materialize the vocabulary into each read-only peer, so the peer config, the
    // permission gate, and the supervisor briefing all read one list.
    agents: config.agents.map((agent) => ({
      ...agent,
      shell_allowlist:
        agent.shell_allowlist ??
        (agent.permissions.shell && !agent.permissions.edit
          ? config.session.shell_vocabulary
          : undefined),
    })),
  }));

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export function parseSessionConfig(
  input: unknown,
  isFreeModel: (model: string) => boolean = () => false,
): SessionConfig {
  const config = SessionConfigSchema.parse(input);
  const errors = config.agents
    .filter((a) => isFreeModel(a.model) && a.max_tokens === undefined && a.allow_unbounded !== true)
    .map(
      (a) =>
        `agents[].${a.id}: unpriced model "${a.model}" requires max_tokens (or allow_unbounded: true)`,
    );
  if (errors.length > 0) throw new Error(errors.join("; "));
  return config;
}
