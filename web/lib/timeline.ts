import { parseJsonl } from "../../shared/parse-jsonl";
import { turnDurations, turnKey } from "../../shared/turn";
import type { DirReader } from "./discovery";

export interface TimelineEvent {
  timestamp: number;
  type: string;
  id?: string;
  sender?: string;
  recipient?: string;
  turnKey?: string;
  isOpen: boolean;
  isClose: boolean;
}

export interface Timeline {
  events: TimelineEvent[];
  durationsByAgent: Record<string, number[]>;
  actors: string[];
  types: string[];
}

type RawRecord = Record<string, unknown>;

const OPEN = new Set(["WORK_ORDER", "PROMPT"]);
const CLOSE = new Set(["FINAL_REPORT", "RESPONSE"]);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function eventType(e: RawRecord): string {
  return str(e.type) ?? str(e.event) ?? "unknown";
}

function toEvent(e: RawRecord): TimelineEvent {
  const type = eventType(e);
  return {
    timestamp: num(e.timestamp) ?? 0,
    type,
    id: str(e.id),
    sender: str(e.sender),
    recipient: str(e.recipient),
    turnKey: turnKey(e),
    isOpen: OPEN.has(type),
    isClose: CLOSE.has(type),
  };
}

function peerIds(records: RawRecord[]): Set<string> {
  const peers = new Set<string>();
  for (const e of records) {
    for (const v of [str(e.sender), str(e.recipient)]) {
      if (v !== undefined && v !== "supervisor") peers.add(v);
    }
  }
  return peers;
}

/** Build the typed timeline aggregate from conversation.jsonl text. */
export function buildTimeline(text: string): Timeline {
  const records = parseJsonl(text);
  const peers = peerIds(records);

  const events = records.map(toEvent).sort((a, b) => a.timestamp - b.timestamp);

  return {
    events,
    durationsByAgent: turnDurations(records, peers),
    actors: [...peers].sort(),
    types: [...new Set(events.map((e) => e.type))].sort(),
  };
}

/** Load a task's conversation.jsonl through the reader; null when absent. */
export async function loadTimeline(
  reader: DirReader,
  runDetailsPath: string,
): Promise<Timeline | null> {
  const conversation = await reader.readText(`${runDetailsPath}/conversation.jsonl`);
  return conversation === null ? null : buildTimeline(conversation.text);
}
