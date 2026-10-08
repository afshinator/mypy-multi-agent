/**
 * pi extension assembly: registers /mypi-multi-agent and the lifecycle commands,
 * and exposes the supervisor's bus tools. Glue over the tested runtime modules;
 * the bus and peer spawning start here (not in the factory), per pi's lifecycle.
 * Loaded by path (nothing imports it); on session_shutdown it aborts any still-
 * active run so peers do not outlive pi.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parse as parseYaml } from "yaml";
import { isFreeCost } from "../budget/pricing-resolver";
import type { UsageAccounting } from "../budget/usage-accounting";
import type { A2AEnvelope } from "../contracts/a2a-schema";
import { parseSessionConfig, type SessionConfig } from "../contracts/session-schema";
import { HerdrCliClient } from "../herdr/herdr-client";
import { ConversationLog } from "../logging/conversation-log";
import { Runtime } from "../runtime/runtime";
import { resolveSessionPath } from "./session-path";
import { sumSupervisorUsage } from "./supervisor-usage";

const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: undefined });

// Resolve the peer harness + supervisor brain relative to this extension, so the
// system works from any project directory (not just this repo's cwd).
const here = dirname(fileURLToPath(import.meta.url));
const peerScript = resolve(here, "../peer/peer-main.ts");
const supervisorPromptPath = resolve(here, "supervisor-prompt.md");

// pi loads this extension by file path (nothing in the repo imports it), so the
// default factory is the real entry point; fallow's unused-export here is a
// false positive for by-path loads.
// fallow-ignore-next-line unused-export
export default function (pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let config: SessionConfig | undefined;
  let seq = 0;

  /** Shared by the /finalize command and the finalize tool. */
  async function finalizeRun(
    dod: boolean,
    entries: Parameters<typeof sumSupervisorUsage>[0],
    decision?: string,
  ): Promise<string> {
    if (!runtime) return "no active run";
    await runtime.finalize(dod, sumSupervisorUsage(entries), decision);
    await runtime.stop();
    await runtime.cleanup();
    // Release the run so /mypi-multi-agent can start a fresh one.
    runtime = undefined;
    return dod ? "finalized: success (exit 0)" : "finalized: failure (exit 1)";
  }

  // Skip only a COMPLETE (finalized) session: aborting it would throw on the
  // finalizing transition and could overwrite final.md. ACTIVE, FINALIZING, and
  // ABORTED sessions still run the full abort/teardown flow.
  pi.on("session_shutdown", async () => {
    if (runtime && runtime.session.current !== "COMPLETE") await runtime.abort().catch(() => {});
  });

  // stop-all (graceful) vs kill-all (immediate) read the same: both terminate
  // panes and abort the turn, but only kill-all aborts the agent sessions.
  pi.registerCommand("stop-all", {
    description: "Gracefully stop all peers and abort the supervisor's current turn",
    handler: async (_args, ctx) => {
      if (!runtime) return;
      runtime.controlPlane.stopAll("user");
      await runtime.paneManager.terminateAll();
      ctx.abort();
    },
  });

  pi.registerCommand("stop", {
    description: "Gracefully stop one peer",
    handler: async (args) => {
      if (!runtime) return;
      const agentId = args.trim();
      runtime.controlPlane.stopAgent(agentId, "user");
      await runtime.paneManager.terminate(agentId);
    },
  });

  pi.registerCommand("kill-all", {
    description: "Immediately terminate all non-supervisor peers",
    handler: async (_args, ctx) => {
      if (!runtime) return;
      runtime.controlPlane.killAll("user");
      await runtime.paneManager.terminateAll();
      ctx.abort();
    },
  });

  pi.registerCommand("finalize", {
    description: "Write final.md and tear down (true = Definition of Done satisfied)",
    handler: async (args, ctx) => {
      const dod = args.trim() === "true";
      const msg = await finalizeRun(dod, ctx.sessionManager.getEntries());
      ctx.ui.notify(msg, dod ? "info" : "error");
    },
  });

  pi.registerCommand("mypi-multi-agent", {
    description: "Start a multi-agent run from a session.yaml",
    handler: async (args, ctx) => {
      if (runtime) {
        ctx.ui.notify("a run is already active; finalize it first", "error");
        return;
      }
      // Pane spawning is the only way peers get a terminal; refuse outside herdr.
      if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
        ctx.ui.notify("run inside a herdr pane first: launch herdr, then run `just run` inside a pane", "error");
        return;
      }
      let path: string;
      try {
        path = await resolveSessionPath(process.cwd(), args.trim() || undefined);
      } catch (err) {
        ctx.ui.notify((err as Error).message, "error");
        return;
      }
      // Resolve "provider/model" slugs against the catalog so a free model is
      // correctly required to carry max_tokens, and usage-gap logging skips it.
      const isFreeModel = (slug: string): boolean => {
        const i = slug.indexOf("/");
        if (i <= 0) return false;
        const model = ctx.modelRegistry.find(slug.slice(0, i), slug.slice(i + 1));
        return model !== undefined && isFreeCost(model.cost);
      };
      try {
        const raw = await readFile(path, "utf8");
        config = parseSessionConfig(parseYaml(raw), isFreeModel);
      } catch (err) {
        ctx.ui.notify(`session.yaml invalid: ${(err as Error).message}`, "error");
        return;
      }
      const askDir = resolve(dirname(path));
      await applySupervisorModel(pi, ctx, config.session.supervisor_model, askDir);
      runtime = new Runtime(askDir, new HerdrCliClient(), config, {
        peerScript,
        isFreeModel,
        heartbeatIntervalMs: config.bus?.heartbeat_interval_ms,
        heartbeatTimeoutMs: config.session.heartbeat_timeout_ms,
      });
      try {
        await runtime.start();
        await runtime.spawnPeers();
      } catch (err) {
        // A failed boot must not leave the re-entry guard latched, nor a
        // half-started bus/heartbeat alive.
        await runtime.stop().catch(() => {});
        runtime = undefined;
        ctx.ui.notify(`failed to start run: ${(err as Error).message}`, "error");
        return;
      }
      const brain = await readFile(supervisorPromptPath, "utf8").catch(() => "");
      pi.sendUserMessage(`${brain}\n\n${briefing(config, askDir)}`);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description: "Return known peer ids and state",
    parameters: Type.Object({}),
    execute: async () => {
      if (!runtime) return text("(no active run)");
      const lines = formatAgents(runtime.registry.ids(), runtime.states, runtime.accounting);
      const max = config?.session.max_cost_usd ?? 0;
      const wallClockMs = config?.session.wall_clock_ms;
      const wallClock = wallClockMs
        ? `\nWALL CLOCK: ${Math.round(runtime.elapsedMs() / 1000)}s elapsed / ${Math.round(wallClockMs / 1000)}s budget`
        : "";
      return text(`${lines}\nSESSION: $${runtime.accounting.getSessionCost().toFixed(4)} / $${max} · ${runtime.accounting.getSessionTokens()} tokens${wallClock}`);
    },
  });

  pi.registerTool({
    name: "dispatch_work_order",
    label: "Dispatch work order",
    description: "Assign a peer a concrete task with a checkable local DoD",
    parameters: Type.Object({
      agentId: Type.String(),
      action: Type.String(),
      localDoD: Type.String(),
      contextFiles: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_id, params) => {
      if (!runtime) return text("no active run");
      const ok = runtime.dispatch(params.agentId, {
        taskId: `task-${++seq}`,
        action: params.action,
        contextFiles: params.contextFiles ?? [],
        constraints: params.constraints ?? [],
        localDoD: params.localDoD,
      });
      return text(ok
        ? `dispatched to ${params.agentId} (state: ${runtime.states.get(params.agentId) ?? "?"})`
        : "session is finalizing; not dispatched");
    },
  });

  pi.registerTool({
    name: "collect_reports",
    label: "Collect reports",
    description: "Read pending FINAL_REPORTs from peers",
    parameters: Type.Object({}),
    execute: async () => text(runtime ? runtime.collectReports() : "(no active run)"),
  });

  pi.registerTool({
    name: "send_prompt",
    label: "Send prompt",
    description: "Send a conversational request to another peer",
    parameters: Type.Object({ agentId: Type.String(), text: Type.String(), timeoutMs: Type.Optional(Type.Number()) }),
    execute: async (_id, params) => {
      if (!runtime) return text("no active run");
      const timeout = params.timeoutMs ?? config?.session.peer_prompt_timeout_ms ?? 120_000;
      const reply = await runtime.sendPrompt("supervisor", params.agentId, params.text, timeout);
      return text((reply.payload as { text: string }).text);
    },
  });

  pi.registerTool({
    name: "await_response",
    label: "Await response",
    description: "Block until an inbound message (prompt, response, or final report) arrives for an agent",
    parameters: Type.Object({
      agentId: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params) => {
      if (!runtime) return text("no active run");
      try {
        const timeout = params.timeoutMs ?? config?.session.peer_prompt_timeout_ms ?? 120_000;
        const reply = await runtime.awaitResponse(params.agentId ?? "supervisor", timeout);
        return text(replyText(reply));
      } catch (err) {
        return text(`await_response failed: ${(err as Error).message}`);
      }
    },
  });

  pi.registerTool({
    name: "finalize",
    label: "Finalize run",
    description: "End the run: writes final.md (your decision record + cost/status) and findings.md (raw peer reports), then tears down peers. Pass dod=true if the Definition of Done is met. Pass decision with your per-section record: the tension between dev_a and dev_b, the reviewer's verdict, and the call you made.",
    parameters: Type.Object({ dod: Type.Boolean(), decision: Type.Optional(Type.String()) }),
    execute: async (_id, params, _signal, _onUpdate, ctx) =>
      text(await finalizeRun(params.dod, ctx.sessionManager.getEntries(), params.decision)),
  });

  pi.registerTool({
    name: "stop_all",
    label: "Stop all peers",
    description: "Gracefully stop all peers",
    parameters: Type.Object({}),
    execute: async () => {
      if (!runtime) return text("no active run");
      runtime.controlPlane.stopAll("supervisor");
      await runtime.paneManager.terminateAll();
      return text("stopped all peers");
    },
  });

  pi.registerTool({
    name: "stop",
    label: "Stop one peer",
    description: "Gracefully stop one peer",
    parameters: Type.Object({ agentId: Type.String() }),
    execute: async (_id, params) => {
      if (!runtime) return text("no active run");
      runtime.controlPlane.stopAgent(params.agentId, "supervisor");
      await runtime.paneManager.terminate(params.agentId);
      return text(`stopped ${params.agentId}`);
    },
  });

  pi.registerTool({
    name: "kill_all",
    label: "Kill all peers",
    description: "Immediately terminate all non-supervisor peers",
    parameters: Type.Object({}),
    execute: async () => {
      if (!runtime) return text("no active run");
      runtime.controlPlane.killAll("supervisor");
      await runtime.paneManager.terminateAll();
      return text("killed all peers");
    },
  });

}

/** Resolve a `provider/model` slug and switch the supervisor's model; on a miss,
 * notify and log a supervisor-model-miss ERROR to the run's conversation log. */
async function applySupervisorModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  slug: string | undefined,
  askDir: string,
): Promise<void> {
  if (!slug) return;
  const i = slug.indexOf("/");
  if (i <= 0) return;
  const model = ctx.modelRegistry.find(slug.slice(0, i), slug.slice(i + 1));
  if (model) {
    await pi.setModel(model);
    return;
  }
  const message = `supervisor model not found: ${slug}`;
  ctx.ui.notify(message, "error");
  // The run's conversation log lives under run-details/; create it so the
  // diagnostic lands where the supervisor reads it (the pre-runtime dir may not exist yet).
  const runDetailsDir = join(askDir, "run-details");
  await mkdir(runDetailsDir, { recursive: true });
  await new ConversationLog(join(runDetailsDir, "conversation.jsonl")).append({
    type: "ERROR",
    id: `supervisor-model-${Date.now()}`,
    timestamp: Date.now(),
    sender: "supervisor",
    recipient: "supervisor",
    payload: { code: "SUPERVISOR_MODEL_NOT_FOUND", message },
  });
}

/** Format an awaitResponse reply as tool-result text: a crashed peer reads
 * differently from a normal text/report payload. */
function replyText(reply: A2AEnvelope): string {
  if (reply.type === "AGENT_CRASHED") {
    const p = reply.payload as { agentId: string; reason?: string };
    return `peer ${p.agentId} CRASHED: ${p.reason ?? "unknown"}`;
  }
  const p = reply.payload as { text?: string; report?: string };
  return p.text ?? p.report ?? "";
}

/** Format known agent ids + states + cost/token usage as a `- id (state) — $cost / N tokens` list (list_agents output). */
export function formatAgents<S>(ids: Iterable<string>, states: Map<string, S>, accounting: UsageAccounting): string {
  return [...ids].map((id) => {
    const cost = accounting.getAgentCost(id);
    const tokens = accounting.getAgentTokens(id);
    return `- ${id} (${states.get(id) ?? "?"}) — $${cost.toFixed(4)} / ${tokens} tokens`;
  }).join("\n");
}

function briefing(c: SessionConfig, askDir: string): string {
  const agents = c.agents
    .map((a) => {
      const perms = [a.permissions.read && "read", a.permissions.edit && "edit", a.permissions.shell && "shell"]
        .filter(Boolean)
        .join("/");
      const budget = `$${a.max_cost_usd}${a.max_tokens !== undefined ? ` / ${a.max_tokens} tokens` : ""}`;
      return `- ${a.id} (${a.title}) — model ${a.model}, perms ${perms}, budget ${budget}`;
    })
    .join("\n");
  return [
    ...(c.session.supervisor_system_prompt ? [c.session.supervisor_system_prompt, ""] : []),
    "Here is the session you are supervising.",
    "",
    `ASK: ${c.ask.title}`,
    c.ask.description,
    `Definition of Done: ${c.ask.definition_of_done}`,
    "",
    "AGENTS:",
    agents,
    "",
    `SESSION: global budget $${c.session.max_cost_usd}, stop threshold ${c.session.agent_stop_threshold_percent}%`,
    `TASK DIRECTORY: ${askDir}`,
    `(Write plan.md and all per-run files in its run-details/ subdirectory, not the repo root.)`,
  ].join("\n");
}
