/**
 * `000-batches/<id>/request.yaml`: one batch, authored once by `mypi-batch new`.
 *
 * The id is a directory name and the prefix of every generated slug
 * (`b-<id>-t<n>`), so it is checked against what a task dir and a slug can carry
 * before anything is written.
 */
import { parse, stringify } from "yaml";

export interface BatchRequest {
  id: string;
  tickets: number[];
  /**
   * One kind for every ticket, or one per ticket. A `--kind` pin outranks the scalar form and is
   * refused beside a mapping; a ticket the mapping omits is classified by triage (#465).
   */
  kind?: string | Record<number, string>;
  /**
   * `{ dependent: dependency }`: the dependent runs after its dependency and bases
   * its branch on it, so the dependency's committed work is present. One edge per
   * ticket, acyclic — a forest of chains.
   */
  dependsOn?: Record<number, number>;
}

export const REQUEST_ID = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** Numeric batch ids keep task directories sortable; legacy ids retain their old slug shape. */
export function batchTaskSlug(batch: string, ticket: number): string {
  return `${/^\d{3,}-/.test(batch) ? batch : `b-${batch}`}-t${ticket}`;
}

export function parseRequest(text: string): BatchRequest {
  const root: unknown = parse(text);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("request must be a mapping");
  }
  const { id, tickets, kind, dependsOn } = root as Record<string, unknown>;
  for (const bad of ["depends-on", "depends_on"]) {
    if (bad in root) throw new Error(`use dependsOn, not ${bad}`);
  }

  if (typeof id !== "string" || !REQUEST_ID.test(id)) {
    throw new Error(`id must match ${REQUEST_ID.source}, got "${String(id)}"`);
  }
  if (!Array.isArray(tickets) || tickets.length === 0)
    throw new Error("request needs at least one ticket");

  const numbers: number[] = [];
  for (const ticket of tickets) {
    if (typeof ticket !== "number" || !Number.isInteger(ticket) || ticket <= 0) {
      throw new Error(`ticket must be a positive issue number, got "${String(ticket)}"`);
    }
    if (numbers.includes(ticket)) throw new Error(`duplicate ticket ${ticket}`);
    numbers.push(ticket);
  }

  const request: BatchRequest = { id, tickets: numbers };
  if (kind !== undefined) request.kind = parseKind(kind, numbers);
  if (dependsOn !== undefined) {
    request.dependsOn = parseDependsOn(dependsOn, numbers);
  }
  return request;
}

/** A scalar kind for the whole batch, or a mapping that names only tickets in the request. */
function parseKind(value: unknown, tickets: number[]): string | Record<number, string> {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("kind must be a string, or a mapping of ticket to kind");
  }
  const out: Record<number, string> = {};
  for (const [key, kind] of Object.entries(value as Record<string, unknown>)) {
    const ticket = Number(key);
    if (!Number.isInteger(ticket) || !tickets.includes(ticket)) {
      throw new Error(`kind names ticket ${key}, which is not in the request`);
    }
    if (typeof kind !== "string") throw new Error(`kind for ticket ${key} must be a string`);
    out[ticket] = kind;
  }
  return out;
}

/** `{ dependent: dependency }`: each names a ticket in the request, one edge, acyclic. */
function parseDependsOn(value: unknown, tickets: number[]): Record<number, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("dependsOn must be a mapping of dependent -> dependency");
  }
  const out: Record<number, number> = {};
  for (const [key, dep] of Object.entries(value as Record<string, unknown>)) {
    const dependent = Number(key);
    if (!Number.isInteger(dependent) || typeof dep !== "number" || !Number.isInteger(dep)) {
      throw new Error(`dependsOn entry "${key}" must map a ticket number to a ticket number`);
    }
    if (!tickets.includes(dependent)) {
      throw new Error(`dependsOn names dependent #${dependent}, which is not in the request`);
    }
    if (!tickets.includes(dep)) {
      throw new Error(`dependsOn names dependency #${dep}, which is not in the request`);
    }
    if (dependent === dep) throw new Error(`ticket ${dependent} cannot depend on itself`);
    out[dependent] = dep;
  }
  orderTickets(tickets, out); // throws on a cycle
  return out;
}

/** Every ticket after every ticket it (transitively) depends on; throws on a cycle. */
export function orderTickets(tickets: number[], dependsOn: Record<number, number>): number[] {
  const state = new Map<number, "visiting" | "done">();
  const out: number[] = [];
  const visit = (t: number): void => {
    const s = state.get(t);
    if (s === "done") return;
    if (s === "visiting") throw new Error("dependsOn contains a cycle");
    state.set(t, "visiting");
    const dep = dependsOn[t];
    if (dep !== undefined) visit(dep);
    state.set(t, "done");
    out.push(t);
  };
  for (const t of tickets) visit(t);
  return out;
}

export function requestYaml(request: BatchRequest): string {
  const text = stringify(request);
  // Prove the bytes, not the object: the caller writes this text to disk.
  parseRequest(text);
  return text;
}
