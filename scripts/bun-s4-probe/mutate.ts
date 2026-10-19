/**
 * Oracle mutation test: prove the A1-A10 grader actually rejects wrong inputs.
 * Each case clones the known-good span set, applies ONE targeted corruption by
 * locating the target INSIDE the clone, and asserts the specific assertion id fires.
 */
import { grade, type SpanRecord } from "./core";
import { FieldsOnly } from "./strategies";
import { runScenario, makeFacts } from "./scenario";

const good = await runScenario(new FieldsOnly());
const facts = makeFacts();

if (grade(good.spans, facts).length !== 0) {
  console.error("BASELINE BROKEN: good spans do not pass the oracle");
  process.exit(1);
}

let pass = 0;
let miss = 0;
function expect(name: string, mutate: (s: SpanRecord[]) => void, assertion: string): void {
  const copy = structuredClone(good.spans);
  mutate(copy);
  const failures = grade(copy, facts);
  const hit = failures.some((f) => f.startsWith(assertion));
  if (hit) { pass++; console.log(`PASS  ${name} -> ${assertion}`); }
  else { miss++; console.error(`MISS  ${name}: expected ${assertion}, got: ${failures.length ? failures.join(" | ") : "NO FAILURES"}`); }
}

const one = <T>(xs: T[], label: string): T => {
  if (xs.length !== 1) throw new Error(`expected 1 ${label}, got ${xs.length}`);
  return xs[0]!;
};
const loc = (s: SpanRecord[], name: SpanRecord["name"], pred?: (x: SpanRecord) => boolean) =>
  one(s.filter((x) => x.name === name && (pred ? pred(x) : true)), `${name}${pred ? " (pred)" : ""}`);
const remove = (s: SpanRecord[], x: SpanRecord) => { const i = s.findIndex((y) => y.span_id === x.span_id); if (i >= 0) s.splice(i, 1); };

// A1
expect("remove run span", (s) => remove(s, loc(s, "run")), "A1");
expect("bad trace_id", (s) => { s[0]!.trace_id = "abcd"; }, "A1");
expect("duplicate span_id", (s) => { s[1]!.span_id = s[0]!.span_id; }, "A1");

// A2
expect("dispatch wrong kind", (s) => { loc(s, "dispatch", (x) => x.scope_id === "T-A").kind = "run-level"; }, "A2");
expect("run-level has scope", (s) => { loc(s, "run").scope_id = "T-A"; }, "A2");

// A3
expect("unknown scope", (s) => { loc(s, "tool", (x) => x.operation_id === "tool-A-1").scope_id = "UNKNOWN"; }, "A3");

// A4
expect("dispatch wrong parent", (s) => { loc(s, "dispatch", (x) => x.scope_id === "T-A").parent_span_id = loc(s, "tool", (x) => x.operation_id === "tool-A-1").span_id; }, "A4");
expect("tool parent not peer.turn", (s) => { loc(s, "tool", (x) => x.operation_id === "tool-A-1").parent_span_id = loc(s, "dispatch", (x) => x.scope_id === "T-A").span_id; }, "A4");
expect("final_report wrong parent", (s) => { loc(s, "final_report", (x) => x.scope_id === "T-A").parent_span_id = loc(s, "run").span_id; }, "A4");

// A5
expect("cross-process parent broken", (s) => { loc(s, "peer.turn", (x) => x.scope_id === "T-A").parent_span_id = loc(s, "peer.turn", (x) => x.scope_id === "T-B").span_id; }, "A5");

// A6
expect("cross-scope parent", (s) => { loc(s, "tool", (x) => x.operation_id === "tool-A-1").parent_span_id = loc(s, "peer.turn", (x) => x.scope_id === "T-B").span_id; }, "A6");
expect("concurrency leak A->B", (s) => { loc(s, "tool", (x) => x.operation_id === "tool-A-1").parent_span_id = loc(s, "dispatch", (x) => x.scope_id === "T-B").span_id; }, "A6");
expect("prompt parent != sender scope", (s) => { loc(s, "prompt").parent_span_id = loc(s, "peer.turn", (x) => x.scope_id === "prompt-1").span_id; }, "A6");

// A7
expect("open span", (s) => { loc(s, "tool", (x) => x.operation_id === "tool-A-1").end_time = null; }, "A7");

// A8
expect("fabricated link", (s) => { loc(s, "finalize").links.push({ span_id: loc(s, "tool", (x) => x.operation_id === "tool-A-1").span_id, reason: "fabricated" }); }, "A8");

// A10
expect("missing operation_id", (s) => { delete loc(s, "dispatch", (x) => x.scope_id === "T-A").operation_id; }, "A10");

// A9
expect("coverage gap (remove tool span)", (s) => remove(s, loc(s, "tool", (x) => x.operation_id === "tool-A-1")), "A9");
expect("duplicate tool span", (s) => { const t = loc(s, "tool", (x) => x.operation_id === "tool-A-1"); s.push(structuredClone(t)); }, "A9");

console.log(`\n${pass} passed, ${miss} missed`);
if (miss > 0) process.exit(1);
