import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false });

/** Render Markdown with raw HTML escaped (LLM-generated content is untrusted). */
export function renderMarkdown(text: string): string {
  return md.render(text);
}
