/**
 * Pre-spawn model checks: which configured agents have a slug the operator's key
 * cannot actually use (MT-1), and which agents share a slug (MT-6). Pure and
 * registry-injected so the extension can call it and tests need no real key.
 */
export interface UnusableModel {
  agentId: string;
  model: string;
  reason: string;
}

export interface DuplicateSlug {
  model: string;
  agentIds: string[];
}

/** The subset of pi's ModelRegistry this module needs. */
export interface ModelLookup<M> {
  find(provider: string, model: string): M | undefined;
  hasConfiguredAuth(model: M): boolean;
}

/** One entry per agent whose model cannot be used; each distinct slug is resolved once. */
export function findUnusableModels<M>(
  registry: ModelLookup<M>,
  agents: readonly { id: string; model: string }[],
): UnusableModel[] {
  const reasonBySlug = new Map<string, string | undefined>();
  const out: UnusableModel[] = [];
  for (const agent of agents) {
    if (!reasonBySlug.has(agent.model))
      reasonBySlug.set(agent.model, resolveUnusable(registry, agent.model));
    const reason = reasonBySlug.get(agent.model);
    if (reason !== undefined) out.push({ agentId: agent.id, model: agent.model, reason });
  }
  return out;
}

function resolveUnusable<M>(registry: ModelLookup<M>, slug: string): string | undefined {
  const i = slug.indexOf("/");
  if (i <= 0) return "malformed slug (expected provider/model)";
  const provider = slug.slice(0, i);
  const model = registry.find(provider, slug.slice(i + 1));
  if (model === undefined) return "not in the model catalog";
  if (!registry.hasConfiguredAuth(model)) return `no provider auth for "${provider}"`;
  return undefined;
}

/** Slugs configured on more than one agent — a shared point of failure. */
export function duplicateModelSlugs(
  agents: readonly { id: string; model: string }[],
): DuplicateSlug[] {
  const byModel = new Map<string, string[]>();
  for (const agent of agents) {
    const ids = byModel.get(agent.model) ?? [];
    ids.push(agent.id);
    byModel.set(agent.model, ids);
  }
  return [...byModel]
    .filter(([, agentIds]) => agentIds.length > 1)
    .map(([model, agentIds]) => ({ model, agentIds }));
}
