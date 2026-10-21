import { summarizeTimeline } from "../lib/summaries";
import type { Timeline, TimelineEvent } from "../lib/timeline";
import { makeAccordion } from "./accordion";

const fmtMs = (ms: number): string => {
  const seconds = ms / 1000;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds % 60)}s`;
  }
  return `${seconds.toFixed(1)}s`;
};

const fmtTime = (ts: number): string => new Date(ts).toLocaleTimeString();

function matches(event: TimelineEvent, type: string, actor: string): boolean {
  if (type !== "all" && event.type !== type) return false;
  if (actor !== "all" && event.sender !== actor && event.recipient !== actor) return false;
  return true;
}

function option(value: string, label: string): HTMLOptionElement {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}

/** Timeline view: filterable chronological events plus per-agent turn durations. */
export function renderTimeline(timeline: Timeline | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "timeline";

  const heading = document.createElement("h2");
  heading.textContent = "Timeline";
  section.append(heading);

  if (timeline === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "Timeline not available (no conversation.jsonl).";
    section.append(missing);
    return section;
  }

  const filters = document.createElement("div");
  filters.className = "timeline-filters";

  const typeSelect = document.createElement("select");
  typeSelect.setAttribute("aria-label", "Filter by event type");
  typeSelect.append(option("all", "All types"));
  for (const type of timeline.types) typeSelect.append(option(type, type));

  const actorSelect = document.createElement("select");
  actorSelect.setAttribute("aria-label", "Filter by actor");
  actorSelect.append(option("all", "All actors"));
  for (const actor of timeline.actors) actorSelect.append(option(actor, actor));

  filters.append(typeSelect, actorSelect);
  section.append(filters);

  const list = document.createElement("ol");
  list.className = "timeline-list";
  section.append(list);

  const refresh = (): void => {
    list.replaceChildren();
    if (timeline.events.length === 0) {
      const empty = document.createElement("li");
      empty.className = "timeline-empty";
      empty.textContent = "No conversation recorded.";
      list.append(empty);
      return;
    }
    for (const event of timeline.events) {
      if (!matches(event, typeSelect.value, actorSelect.value)) continue;
      const li = document.createElement("li");
      li.className = "timeline-event";

      const time = document.createElement("time");
      time.dateTime = new Date(event.timestamp).toISOString();
      time.textContent = fmtTime(event.timestamp);
      time.className = "timeline-time";

      const typeBadge = document.createElement("span");
      typeBadge.className = "timeline-type";
      typeBadge.textContent = event.type;

      const actors = document.createElement("span");
      actors.className = "timeline-actors";
      actors.textContent = `${event.sender ?? "—"} → ${event.recipient ?? "—"}`;

      li.append(time, typeBadge, actors);
      list.append(li);
    }
  };
  typeSelect.addEventListener("change", refresh);
  actorSelect.addEventListener("change", refresh);
  refresh();

  const agents = Object.keys(timeline.durationsByAgent).sort();
  if (agents.length > 0) {
    const subHeading = document.createElement("h3");
    subHeading.textContent = "Turn durations";
    section.append(subHeading);

    const dl = document.createElement("dl");
    dl.className = "turn-durations";
    for (const agent of agents) {
      const dt = document.createElement("dt");
      dt.textContent = agent;
      const dd = document.createElement("dd");
      dd.textContent = (timeline.durationsByAgent[agent] ?? []).map(fmtMs).join(", ");
      dl.append(dt, dd);
    }
    section.append(dl);
  }

  makeAccordion(section, summarizeTimeline(timeline), "accordion-timeline");
  return section;
}
