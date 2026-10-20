import { renderMarkdown } from "../lib/markdown";
import type { PlanFindings } from "../lib/plan-findings";

function panel(title: string, text: string | null, missingLabel: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "markdown-panel";

  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);

  if (text === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = missingLabel;
    section.append(missing);
    return section;
  }

  const body = document.createElement("div");
  body.className = "markdown-body";
  body.innerHTML = renderMarkdown(text);
  section.append(body);
  return section;
}

/** Plan + findings panels, rendered via markdown-it with html: false. */
export function renderPlanFindings(doc: PlanFindings): HTMLElement {
  const section = document.createElement("section");
  section.className = "plan-findings";

  const heading = document.createElement("h2");
  heading.textContent = "Plan & findings";
  section.append(heading);

  section.append(panel("Plan", doc.plan, "Plan not available (no plan.md)."));
  section.append(panel("Findings", doc.findings, "Findings not available (no findings.md)."));
  return section;
}
