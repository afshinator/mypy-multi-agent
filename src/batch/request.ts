/**
 * `batches/<id>/request.yaml`: one batch, authored once by `mypi-batch new`.
 *
 * The id is a directory name and the prefix of every generated slug
 * (`b-<id>-t<n>`), so it is checked against what a task dir and a slug can carry
 * before anything is written.
 */
import { parse, stringify } from "yaml";

export interface BatchRequest {
  id: string;
  tickets: number[];
  /** Default kind for the batch; `prepare` falls back to the policy's first kind. */
  kind?: string;
}

export const REQUEST_ID = /^[a-z0-9][a-z0-9-]{0,48}$/;

export function parseRequest(text: string): BatchRequest {
  const root: unknown = parse(text);
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("request must be a mapping");
  }
  const { id, tickets, kind } = root as Record<string, unknown>;

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
  if (kind !== undefined) {
    if (typeof kind !== "string") throw new Error("kind must be a string");
    request.kind = kind;
  }
  return request;
}

export function requestYaml(request: BatchRequest): string {
  const text = stringify(request);
  // Prove the bytes, not the object: the caller writes this text to disk.
  parseRequest(text);
  return text;
}
