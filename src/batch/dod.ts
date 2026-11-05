/**
 * Batch DoD normalization: the finalize gate compares a criterion byte-for-byte
 * after folding only a leading label, backticks, curly quotes, en/em dashes and
 * whitespace (src/supervisor/finalization.ts). Every other markdown construct
 * therefore fails `criteria` after a run has been paid for, so it is removed
 * here, before the criterion is written to the manifest.
 *
 * Stripping never changes words, order or punctuation; a construct that cannot
 * be removed without rewriting is reported as a problem instead of guessed at.
 */

export interface DodProblem {
  index: number;
  /** `empty` | `table` | `markdown` */
  reason: string;
}

export interface NormalizedDoD {
  criteria: string[];
  problems: DodProblem[];
}

/** Bullets, checkboxes, numbering, headings and blockquotes, in any combination. */
const LEADING = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,3}[:.)]\s+|\[[ xX]\]\s*)+/;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]*\)/g;
const HTML = /<[^>]+>/g;
const STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
/** Star emphasis at a word boundary, so `a*b*c` is left alone. */
const EMPHASIS_STAR = /(?<![\p{L}\p{N}])\*(?=\S)([^*]*\S)\*/gu;
/** Underscore emphasis only at word boundaries, so `snake_case` survives. */
const EMPHASIS_UNDERSCORE = /(?<![\p{L}\p{N}])_(?=\S)([^_]*\S)_(?![\p{L}\p{N}])/gu;
const TABLE = /^\s*\|.*\|\s*$/;
const RESIDUAL = /\*\*|__|\]\(/;

/** Fold markdown in prose only: an inline code span is literal text. */
function foldProse(text: string): string {
  return text
    .replace(IMAGE, "$1")
    .replace(LINK, "$1")
    .replace(HTML, "")
    .replace(STRONG, "$2")
    .replace(EMPHASIS_STAR, "$1")
    .replace(EMPHASIS_UNDERSCORE, "$1");
}

/** Sentinels from the private-use area: no markdown rule matches them and no reply contains them. */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const SPAN_INDEX = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

/** Hide each inline code span behind a placeholder so folding never reaches inside it. */
function protectSpans(raw: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  const text = raw.replace(/`[^`]*`/g, (span) => {
    spans.push(span);
    return `${OPEN}${spans.length - 1}${CLOSE}`;
  });
  return { text, spans };
}

function normalizeOne(raw: string): { criterion: string; reason?: string } {
  const trimmed = raw.trim().replace(LEADING, "");
  // An unmatched backtick leaves no reliable span boundary, so nothing can be folded
  // without guessing which half is literal (#313).
  if ((trimmed.match(/`/g) ?? []).length % 2 === 1) {
    return { criterion: trimmed, reason: "markdown" };
  }
  const { text, spans } = protectSpans(trimmed);
  // One subject for every rule: folded text with its code spans still hidden, so a literal
  // `**` inside a span is not read as leftover markdown.
  const folded = foldProse(text);
  const criterion = folded.replace(SPAN_INDEX, (_, i) => spans[Number(i)] as string).trim();

  if (criterion === "") return { criterion, reason: "empty" };
  if (TABLE.test(criterion)) return { criterion, reason: "table" };
  if (RESIDUAL.test(folded)) return { criterion, reason: "markdown" };
  return { criterion };
}

export function normalizeDoD(criteria: readonly string[]): NormalizedDoD {
  const out: NormalizedDoD = { criteria: [], problems: [] };
  criteria.forEach((raw, index) => {
    const { criterion, reason } = normalizeOne(raw);
    out.criteria.push(criterion);
    if (reason !== undefined) out.problems.push({ index, reason });
  });
  return out;
}
