/**
 * pi extension assembly: registers /mypi-multi-agent and the lifecycle commands,
 * and exposes the supervisor's bus tools. Glue over the tested runtime modules;
 * the bus and peer spawning start here (not in the factory), per pi's lifecycle.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionConfig, type SessionConfig } from "../contracts/session-schema";
import { Runtime } from "../runtime/runtime";
import { HerdrCliClient } from "../herdr/herdr-client";
import { ConversationLog } from "../logging/conversation-log";
import { sumSupervisorUsage } from "./supervisor-usage";
import { resolveSessionPath } from "./session-path";

const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: undefined });

// Resolve the peer harness + supervisor brain relative to this extension, so the
// system works from any project directory (not just this repo's cwd).
const here = dirname(fileURLToPath(import.meta.url));
const peerScript = resolve(here, "../peer/peer-main.ts");
const supervisorPromptPath = resolve(here, "supervisor-prompt.md");

export default function (pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let config: SessionConfig | undefined;
  let seq = 0;

  pi.on("session_shutdown", async () => {
    if (runtime) await runtime.abort().catch(() => {});
  });

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
      if (!runtime) {
        ctx.ui.notify("no active run", "error");
        return;
      }
      const dod = args.trim() === "true";
      const usage = sumSupervisorUsage(ctx.sessionManager.getEntries());
      await runtime.finalize(dod, usage);
      await runtime.stop();
      await runtime.cleanup();
      ctx.ui.notify(dod ? "finalized: success (exit 0)" : "finalized: failure (exit 1)", dod ? "info" : "error");
    },
  });

  pi.registerCommand("mypi-multi-agent", {
    description: "Start a multi-agent run from a session.yaml",
    handler: async (args, ctx) => {
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
      try {
        const raw = await readFile(path, "utf8");
        config = parseSessionConfig(parseYaml(raw));
      } catch (err) {
        ctx.ui.notify(`session.yaml invalid: ${(err as Error).message}`, "error");
        return;
      }
      const askDir = resolve(dirname(path));
      await applySupervisorModel(pi, ctx, config.session.supervisor_model, askDir);
      runtime = new Runtime(askDir, new HerdrCliClient(), config, { peerScript });
      await runtime.start();
      await runtime.spawnPeers();
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
      const r = runtime;
      const lines = [...r.registry.ids()].map((id) => `- ${id} (${r.states.get(id) ?? "?"})`);
      return text(lines.join("\n"));
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
      return text(ok ? `dispatched to ${params.agentId}` : "session is finalizing; not dispatched");
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
        const p = reply.payload as { text?: string; report?: string };
        return text(p.text ?? p.report ?? "");
      } catch (err) {
        return text(`await_response failed: ${(err as Error).message}`);
      }
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
  await new ConversationLog(join(askDir, "conversation.jsonl")).append({
    type: "ERROR",
    id: `supervisor-model-${Date.now()}`,
    timestamp: Date.now(),
    sender: "supervisor",
    recipient: "supervisor",
    payload: { code: "SUPERVISOR_MODEL_NOT_FOUND", message },
  });
}

function briefing(c: SessionConfig, askDir: string): string {
  const agents = c.agents
    .map((a) => {
      const perms = [a.permissions.read && "read", a.permissions.edit && "edit", a.permissions.shell && "shell"]
        .filter(Boolean)
        .join("/");
      const budget = `$${a.max_cost_usd}` + (a.max_tokens !== undefined ? ` / ${a.max_tokens} tokens` : "");
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
    `(Write plan.md and all per-run files here, not the repo root.)`,
  ].join("\n");
}
