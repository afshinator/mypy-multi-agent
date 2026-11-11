/**
 * One `prepare` in its own process, so a test can hold a ticket's lock while another process tries
 * to take it (#427). Not a test itself: test/integration/prepare-lock.test.ts spawns it.
 *
 * argv: <scratch cwd> <barrier dir> <hold|nohold>
 * Prints one JSON line: { code, calls }.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LABELS } from "../../../src/batch/policy";
import { type PrepareDeps, prepare } from "../../../src/batch/prepare";

const [cwd, barrier, mode] = process.argv.slice(2);
if (cwd === undefined || barrier === undefined) throw new Error("usage: <cwd> <barrier> <mode>");

const TRIAGE = [
  "## Claim checks",
  "row 1: a",
  "command: ls a.ts",
  "observed: a.ts",
  "verdict: true",
  "",
  "row 2: b",
  "command: ls b.ts",
  "observed: b.ts",
  "verdict: true",
  "",
  "## Need",
  "n",
  "",
  "## Fix",
  "f",
  "",
  "## Definition of Done",
  "1. one",
  "2. two",
  "",
  "## Verdict",
  "`run`",
  "",
  "KIND: code-fix",
].join("\n");
const BLOCK = `\`\`\`json
[{"row":1,"verdict":"match","evidence":"s","command":"ls a.ts","exit":0},{"row":2,"verdict":"match","evidence":"s","command":"ls b.ts","exit":0}]
\`\`\`

could-not-run: none

\`\`\`json
[{"criterion":1,"verdict":"match","evidence":"ok"},{"criterion":2,"verdict":"mismatch","evidence":"unsound"}]
\`\`\`
`;
const replies = [TRIAGE, BLOCK];
let calls = 0;

const deps: PrepareDeps = {
  cwd,
  tracker: {
    view: async () => ({
      number: 42,
      title: "t",
      body: "",
      state: "OPEN",
      labels: [],
      updatedAt: "",
      comments: [],
    }),
    upsertMarkerComment: async () => ({ action: "created" as const, id: 1 }),
    addLabel: async () => {},
    removeLabel: async () => {},
  },
  agent: async () => {
    calls += 1;
    if (calls === 1) {
      writeFileSync(join(barrier, "claimed"), `${process.pid}\n`);
      if (mode === "hold") {
        const until = Date.now() + 15_000;
        while (!existsSync(join(barrier, "go")) && Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    return { text: replies.shift() ?? "", costUsd: 0.01, turns: 1 };
  },
  preflight: async (slugs: string[]) => slugs.map((slug) => ({ slug, ok: true })),
  clone: { make: async () => cwd, remove: async () => {} },
  revision: () => "rev-1",
};

mkdirSync(barrier, { recursive: true });
const [outcome] = await prepare(
  deps,
  {
    prepare: {
      kinds: ["code-fix"],
      kindTemplates: { "code-fix": "templates/batch-code-fix.yaml" },
      triageModel: "a/b",
      verifierModel: "c/d",
      agentTimeoutMinutes: 5,
    },
    run: { timeoutMinutes: 5 },
    labels: { ...DEFAULT_LABELS },
  },
  { id: "b7", tickets: [42] },
);
console.log(JSON.stringify({ code: outcome?.code ?? "accepted", calls }));
