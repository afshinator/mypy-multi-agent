import { FieldsOnly, OtelSdk } from "./strategies";
import { runScenario } from "./scenario";
import { grade } from "./core";

const summary: string[] = [];
for (const Strat of [FieldsOnly, OtelSdk]) {
  const tracing = new Strat();
  const { spans, facts, prop } = await runScenario(tracing);
  const failures = grade(spans, facts);
  console.log(`\n=== ${tracing.label} ===`);
  console.log(`spans: ${spans.length}`);
  console.log(`propagation (outbound traceparent -> inbound extract):`);
  for (const c of prop) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.key}  extracted=${c.extracted.slice(0, 16)}`);
  console.log(`oracle A1-A10: ${failures.length === 0 ? "PASS (0 failures)" : `FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`  - ${f}`);
  summary.push(`${tracing.label}: spans=${spans.length}, prop=${prop.every((c) => c.ok) ? "PASS" : "FAIL"}, oracle=${failures.length === 0 ? "PASS" : "FAIL"}`);
}
console.log("\n== SUMMARY ==");
for (const s of summary) console.log(s);
process.exit(0);
