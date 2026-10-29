/**
 * Run-level resume contract: a versioned `run-state.json` snapshot written at
 * work-order boundaries and read only by the explicit `--resume` path.
 *
 * The snapshot is a derived state record, never a script for re-applying work:
 * it captures config identity, per-agent usage/budget/state, and the last
 * completed work order per agent. Nothing here re-dispatches a work order.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SessionConfig } from "../contracts/session-schema";
import type { AgentState } from "./state-machine";

const AGENT_STATE_VALUES = ["PENDING", "WORKING", "DONE", "CRASHED", "STOPPED"] as const;

const AgentRunStateSchema = z.strictObject({
  id: z.string().min(1),
  state: z.enum(AGENT_STATE_VALUES),
  model: z.string().min(1),
  usage: z.strictObject({
    costUsd: z.number(),
    tokens: z.number(),
    cacheReadTokens: z.number(),
  }),
  budget: z.strictObject({
    maxCostUsd: z.number(),
    maxTokens: z.number().optional(),
  }),
  lastCompletedWorkOrder: z.string().nullable(),
  inFlightTaskId: z.string().nullable(),
});

export const RunStateV1Schema = z.strictObject({
  version: z.literal("1"),
  configHash: z.string().min(1),
  planPointer: z.string().min(1),
  /** Epoch ms when the run started; bounds supervisor usage to this run. */
  startedAtMs: z.number().int().nonnegative().optional(),
  /** HEAD at run start: the fixed base an aggregate diff must be taken against. */
  baseCommit: z.string().min(1).optional(),
  /** Run totals: every agent, plus the supervisor at finalize when it is known. */
  totals: z.strictObject({
    costUsd: z.number(),
    tokens: z.number(),
  }),
  agents: z.array(AgentRunStateSchema),
});

export type RunStateV1 = z.infer<typeof RunStateV1Schema>;

/** The accounting read surface `buildRunState` needs; `UsageAccounting` satisfies it. */
export interface RunStateAccounting {
  getAgentCost(agentId: string): number;
  getAgentTokens(agentId: string): number;
  getAgentCacheReadTokens(agentId: string): number;
  getSessionCost(): number;
  getSessionTokens(): number;
}

export interface RunStateInput {
  config: SessionConfig;
  rawSessionYaml: string;
  accounting: RunStateAccounting;
  states: ReadonlyMap<string, AgentState>;
  startedAtMs: number;
  baseCommit?: string;
  /** The supervisor's own usage; absent until finalize knows it. */
  supervisorUsage?: { costUsd: number; tokens: number };
  lastCompletedWorkOrder?: ReadonlyMap<string, string>;
  inFlightTaskIds?: ReadonlyMap<string, string>;
  planPointer?: string;
}

export const DEFAULT_PLAN_POINTER = "run-details/plan.md";

/** SHA-256 of the raw session.yaml text — the identity a resume checks against. */
export function hashConfig(rawSessionYaml: string): string {
  return createHash("sha256").update(rawSessionYaml).digest("hex");
}

/** Pure: project live runtime state into the versioned snapshot contract. */
export function buildRunState(input: RunStateInput): RunStateV1 {
  return {
    version: "1",
    configHash: hashConfig(input.rawSessionYaml),
    planPointer: input.planPointer ?? DEFAULT_PLAN_POINTER,
    startedAtMs: input.startedAtMs,
    baseCommit: input.baseCommit,
    totals: {
      costUsd: input.accounting.getSessionCost() + (input.supervisorUsage?.costUsd ?? 0),
      tokens: input.accounting.getSessionTokens() + (input.supervisorUsage?.tokens ?? 0),
    },
    agents: input.config.agents.map((agent) => ({
      id: agent.id,
      state: input.states.get(agent.id) ?? "PENDING",
      model: agent.model,
      usage: {
        costUsd: input.accounting.getAgentCost(agent.id),
        tokens: input.accounting.getAgentTokens(agent.id),
        cacheReadTokens: input.accounting.getAgentCacheReadTokens(agent.id),
      },
      budget: {
        maxCostUsd: agent.max_cost_usd,
        maxTokens: agent.max_tokens,
      },
      lastCompletedWorkOrder: input.lastCompletedWorkOrder?.get(agent.id) ?? null,
      inFlightTaskId: input.inFlightTaskIds?.get(agent.id) ?? null,
    })),
  };
}

export async function writeRunState(dir: string, state: RunStateV1): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** Read + validate; throws on a missing file, bad JSON, or a bad version. */
export async function readRunState(dir: string): Promise<RunStateV1> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "run-state.json"), "utf8");
  } catch (err) {
    throw new Error(`run-state.json not found in ${dir}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`run-state.json is not valid JSON: ${(err as Error).message}`);
  }
  return RunStateV1Schema.parse(parsed);
}

/**
 * Pure resume briefing: what was done, what was spent, and what could NOT be
 * recovered. Never re-dispatches anything — the supervisor decides what is left.
 */
export function buildResumeBriefing(state: RunStateV1, planText: string): string {
  const agents = state.agents
    .map((a) => {
      const last = a.lastCompletedWorkOrder ?? "(no completed work order)";
      const inFlight = a.inFlightTaskId
        ? `; in-flight at snapshot (NOT re-dispatched): ${a.inFlightTaskId}`
        : "";
      return `- ${a.id}: last completed ${last}${inFlight}`;
    })
    .join("\n");
  return [
    "This is a RESUMED run. The run-state snapshot was loaded; no work order has been re-dispatched.",
    "",
    "PLAN:",
    planText,
    "",
    "AGENTS (work so far):",
    agents,
    "",
    `SPEND ALREADY BOOKED: $${state.totals.costUsd.toFixed(4)} / ${state.totals.tokens} tokens`,
    "",
    "WHAT COULD NOT BE RECOVERED:",
    "- peer conversation context (in-memory, lost) — re-brief each peer from the plan above",
    "- file locks (in-memory, lost) — re-acquire before editing",
    "- in-flight edits (unverified) — inspect `git status` / `git diff` before continuing",
    "",
    "Continue from the last completed work order per agent. Do not re-dispatch any completed work order.",
  ].join("\n");
}
