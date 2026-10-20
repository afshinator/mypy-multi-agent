import type { SpanRecord } from "../../shared/traceparent";
import type { SpanTrace } from "../lib/spans";

/** One contract for every chart: typed trace in, DOM out, span selection via callback. */
export interface Chart {
  render(root: HTMLElement, trace: SpanTrace, onSelect: (span: SpanRecord) => void): void;
}
