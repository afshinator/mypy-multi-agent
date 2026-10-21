import type { DirEntry, DirReader, FileText } from "./reader";

export const dummyRunDetailsPath = "dummy-run/run-details";

const finalMd = `---
status: success
exit_code: 0
total_cost_usd: 1.234
total_tokens: 56789
supervisor_cost_usd: 0.4
supervisor_tokens: 12000
agents:
  - name: dev_a
    cost_usd: 0.5
    tokens: 20000
  - name: dev_b
    cost_usd: 0.334
    tokens: 24789
---

# Dummy run report

## Criteria

- [x] The build passes — bun run test is green
- [x] The change is verified — bun run typecheck is clean
- [ ] The docs are updated — pending review
`;

const runStateJson = `{
  "agents": [
    { "id": "supervisor", "state": "done", "model": "deepseek/deepseek-v4-pro", "usage": { "costUsd": 0.4, "tokens": 12000 }, "budget": { "maxCostUsd": 2, "maxTokens": 50000 } },
    { "id": "dev_a", "state": "done", "model": "deepseek/deepseek-v4-pro", "usage": { "costUsd": 0.5, "tokens": 20000 }, "budget": { "maxCostUsd": 2, "maxTokens": 50000 }, "lastCompletedWorkOrder": "Implement the fix" },
    { "id": "dev_b", "state": "done", "model": "fireworks/glm-5p3-flash", "usage": { "costUsd": 0.334, "tokens": 24789 }, "budget": { "maxCostUsd": 2, "maxTokens": 50000 } }
  ]
}
`;

const spansJsonl = [
  '{"span_id":"root","parent_span_id":null,"name":"run","kind":"run-level","start_time":1000,"end_time":9000,"status":"ok","agent_id":null,"scope_id":null,"operation_id":null,"links":[]}',
  '{"span_id":"w1","parent_span_id":"root","name":"work order","kind":"work-order-level","start_time":1200,"end_time":5000,"status":"ok","agent_id":"dev_a","scope_id":"s1","operation_id":"op1","links":[]}',
  '{"span_id":"w2","parent_span_id":"root","name":"work order","kind":"work-order-level","start_time":5200,"end_time":8800,"status":"ok","agent_id":"dev_b","scope_id":"s2","operation_id":"op2","links":[]}',
].join("\n");

const conversationJsonl = [
  '{"type":"WORK_ORDER","timestamp":1200,"id":"wo1","sender":"supervisor","recipient":"dev_a"}',
  '{"type":"FINAL_REPORT","timestamp":5000,"id":"fr1","sender":"dev_a","recipient":"supervisor"}',
  '{"type":"PROMPT","timestamp":5200,"id":"p1","sender":"supervisor","recipient":"dev_b"}',
  '{"type":"RESPONSE","timestamp":8800,"id":"r1","sender":"dev_b","recipient":"supervisor"}',
].join("\n");

const toolCallsJsonl = [
  '{"timestamp":1300,"agentId":"dev_a","toolName":"read","args":{"path":"src/x.ts"},"durationMs":120,"isError":false}',
  '{"timestamp":5400,"agentId":"dev_b","toolName":"bash","args":{"command":"bun run test"},"durationMs":2000,"isError":false}',
].join("\n");

const planMd = `# Plan (dummy)

1. Reproduce the failure.
2. Fix the root cause.
3. Verify with tests.
`;

const findingsMd = `# Findings (dummy)

- Root cause identified in the supervisor finalization gate.
- Tests pass; one criterion still open.
`;

const FILES: Record<string, string> = {
  [`${dummyRunDetailsPath}/final.md`]: finalMd,
  [`${dummyRunDetailsPath}/run-state.json`]: runStateJson,
  [`${dummyRunDetailsPath}/spans.jsonl`]: spansJsonl,
  [`${dummyRunDetailsPath}/conversation.jsonl`]: conversationJsonl,
  [`${dummyRunDetailsPath}/tool-calls.jsonl`]: toolCallsJsonl,
  [`${dummyRunDetailsPath}/plan.md`]: planMd,
  [`${dummyRunDetailsPath}/findings.md`]: findingsMd,
};

/** In-memory DirReader serving the dummy run; the MVP has no file access. */
export class DummyDirReader implements DirReader {
  async list(_path: string): Promise<DirEntry[]> {
    return [];
  }

  async readText(path: string): Promise<FileText | null> {
    const text = FILES[path];
    return text === undefined ? null : { text };
  }
}
