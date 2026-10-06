import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseSessionConfig, type SessionConfig } from "../contracts/session-schema";
import { Runtime } from "../runtime/runtime";
import { HerdrCliClient } from "../herdr/herdr-client";

/**
 * Pi extension assembly (glue over the tested L1-L11 + Runtime). The bus and
 * peer spawning start in /mypi-multi-agent (not the factory), per pi's
 * lifecycle rules.
 */

const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: undefined });

export default function (pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let config: SessionConfig | undefined;
  let seq = 0;

  pi.on("session_shutdown", async () => {
    if (runtime) await runtime.abort().catch(() => {});
  });

  pi.registerCommand("stop-all", {
    description: "Gracefully stop all peers and finalize",
    handler: async () => {
      runtime?.controlPlane.stopAll("user");
    },
  });

  pi.registerCommand("stop", {
    description: "Gracefully stop one peer",
    handler: async (args) => {
      runtime?.controlPlane.stopAgent(args.trim(), "user");
    },
  });

  pi.registerCommand("kill-all", {
    description: "Immediately terminate all non-supervisor peers",
    handler: async () => {
      runtime?.controlPlane.killAll("user");
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
      await runtime.finalize(dod);
      await runtime.stop();
      ctx.ui.notify(dod ? "finalized: success (exit 0)" : "finalized: failure (exit 1)", dod ? "info" : "error");
    },
  });

  pi.registerCommand("mypi-multi-agent", {
    description: "Start a multi-agent run from a session.yaml",
    handler: async (args, ctx) => {
      const path = args.trim() || "session.yaml";
      try {
        const raw = await readFile(path, "utf8");
        config = parseSessionConfig(parseYaml(raw));
      } catch (err) {
        ctx.ui.notify(`session.yaml invalid: ${(err as Error).message}`, "error");
        return;
      }
      if (config.session.supervisor_model) {
        const i = config.session.supervisor_model.indexOf("/");
        if (i > 0) {
          const provider = config.session.supervisor_model.slice(0, i);
          const modelId = config.session.supervisor_model.slice(i + 1);
          const model = ctx.modelRegistry.find(provider, modelId);
          if (model) await pi.setModel(model);
          else ctx.ui.notify(`supervisor model not found: ${config.session.supervisor_model}`, "error");
        }
      }
      runtime = new Runtime(resolve(dirname(path)), new HerdrCliClient(), config);
      await runtime.start();
      await runtime.spawnPeers();
      pi.sendUserMessage(briefing(config));
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
    parameters: Type.Object({ agentId: Type.String(), text: Type.String() }),
    execute: async (_id, params) => {
      if (!runtime) return text("no active run");
      const reply = await runtime.sendPrompt("supervisor", params.agentId, params.text, 10_000);
      return text((reply.payload as { text: string }).text);
    },
  });

  pi.registerTool({
    name: "await_response",
    label: "Await response",
    description: "Block until an incoming message (prompt or response) arrives for an agent",
    parameters: Type.Object({
      agentId: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params) => {
      if (!runtime) return text("no active run");
      try {
        const reply = await runtime.awaitResponse(params.agentId ?? "supervisor", params.timeoutMs ?? 10_000);
        return text((reply.payload as { text?: string }).text ?? "");
      } catch (err) {
        return text(`await_response failed: ${(err as Error).message}`);
      }
    },
  });

}

function briefing(c: SessionConfig): string {
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
  ].join("\n");
}
