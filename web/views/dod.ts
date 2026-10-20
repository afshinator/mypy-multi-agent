import type { DoDCriterion } from "../lib/run-data";

/** DoD checklist view: pass/fail per criterion plus its evidence. */
export function renderDoD(criteria: DoDCriterion[] | null): HTMLElement {
  const section = document.createElement("section");
  section.className = "dod";

  const heading = document.createElement("h2");
  heading.textContent = "DoD checklist";
  section.append(heading);

  if (criteria === null) {
    const missing = document.createElement("p");
    missing.className = "empty";
    missing.textContent = "DoD checklist not available (no final.md).";
    section.append(missing);
    return section;
  }

  if (criteria.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No DoD criteria recorded.";
    section.append(empty);
    return section;
  }

  const ul = document.createElement("ul");
  ul.className = "criteria-list";
  for (const criterion of criteria) {
    const li = document.createElement("li");
    li.className = criterion.pass ? "criterion-pass" : "criterion-fail";

    const mark = document.createElement("span");
    mark.className = "criterion-mark";
    mark.textContent = criterion.pass ? "✓" : "✗";
    mark.setAttribute("aria-label", criterion.pass ? "passed" : "failed");

    const text = document.createElement("span");
    text.className = "criterion-text";
    text.textContent = criterion.criterion;

    li.append(mark, text);

    if (criterion.evidence !== "") {
      const evidence = document.createElement("div");
      evidence.className = "criterion-evidence";
      evidence.textContent = criterion.evidence;
      li.append(evidence);
    }

    ul.append(li);
  }
  section.append(ul);
  return section;
}
