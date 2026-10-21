/**
 * Wrap a view section's body (everything after its h2) in a collapsible
 * accordion. The h2 becomes the toggle button; when collapsed the body is
 * hidden and a one-line summary is shown. State persists in localStorage.
 */
export function makeAccordion(section: HTMLElement, summaryText: string, storageKey: string): void {
  const heading = section.querySelector("h2");
  if (heading === null) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "accordion-toggle";

  const title = document.createElement("span");
  title.className = "accordion-title";
  title.textContent = heading.textContent ?? "";
  button.append(title);

  const summary = document.createElement("span");
  summary.className = "accordion-summary";
  summary.textContent = summaryText;
  button.append(summary);

  const chevron = document.createElement("span");
  chevron.className = "accordion-chevron";
  chevron.setAttribute("aria-hidden", "true");
  button.append(chevron);

  const body = document.createElement("div");
  body.className = "accordion-body";
  body.id = `${storageKey}-body`;
  button.setAttribute("aria-controls", body.id);

  while (heading.nextSibling !== null) body.append(heading.nextSibling);
  heading.replaceWith(button);
  section.append(body);

  const apply = (collapsed: boolean): void => {
    button.setAttribute("aria-expanded", String(!collapsed));
    body.hidden = collapsed;
    summary.hidden = !collapsed;
    chevron.classList.toggle("open", !collapsed);
  };

  button.addEventListener("click", () => {
    const collapsed = !body.hidden;
    localStorage.setItem(storageKey, collapsed ? "collapsed" : "expanded");
    apply(collapsed);
  });

  apply(localStorage.getItem(storageKey) === "collapsed");
}
