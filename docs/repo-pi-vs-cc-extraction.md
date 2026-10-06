# Reusable Pieces from `disler/pi-vs-claude-code`

## Version note (checked 2026-10-06 against current pi-mono docs)

The repo was written against an older Pi SDK. Checked the extracted code
(`coms.ts`, `damage-control.ts`) against the current `extensions.md`. The hooks
are unchanged; the package names are not. Do not copy imports verbatim.

- **V1 (blocks compilation). Package scope renamed.** Repo imports
  `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, and
  `@sinclair/typebox`. Current is `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, and bare `typebox`. Enums now use `StringEnum` from
  `@earendil-works/pi-ai`. Rewrite every import before building. Nothing else in
  the two files changed shape.
- **V2. Extension discovery path moved.** Auto-discovery is now
  `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project).
  `pi -e ./file.ts` still works for quick tests. Prefer `CONFIG_DIR_NAME` over a
  hardcoded `.pi`; `damage-control.ts` hardcodes it.
- **V3 (correctness, affects L8). `agent_end` is not "done".** The docs now warn
  Pi may auto-retry, auto-compact-and-retry, or run queued follow-ups after
  `agent_end`. `coms.ts` captures its response in `agent_end`. For our
  RESPONSE / FINAL_REPORT capture, use the new `agent_settled` event instead,
  which fires only when Pi will not continue on its own.

**Confirmed unchanged (safe to rely on):** `pi.on("tool_call")` returning
`{ block, reason }`; `isToolCallEventType`; `pi.registerTool` /
`registerCommand` / `registerFlag` / `getFlag`; `pi.appendEntry`;
`pi.sendMessage(msg, { deliverAs, triggerTurn })` with `deliverAs` of
`"steer"|"followUp"|"nextTurn"`; `agent_end` + `ctx.sessionManager.getBranch()`;
`ctx.ui.setWidget` / `setStatus` / `notify` / `confirm`.

---

Source repo: https://github.com/disler/pi-vs-claude-code (MIT). A Pi extension
playground. Our system is a hardened, Zod-validated, TDD build of one pattern
inside it. Most extensions are demos. Two files contain code that maps onto
L1/L3/L5/L6, and the repo as a whole is concrete proof of the Pi API that the
Phase 0 spike must verify.

Companion docs: `multi-agent-spec-v1.6.md`, `multi-agent-implementation-plan-v5.md`.

## Do this first

Clone the repo and run `extensions/coms.ts` and `extensions/damage-control.ts`
before writing any L1 code. They exercise the exact Pi hooks our plan depends on.

```
pi -e extensions/coms.ts
pi -e extensions/damage-control.ts
```

## Findings: repo piece -> our layer

| Code | Repo piece | Maps to | Verdict |
|---|---|---|---|
| F1 | `coms.ts` | A2A bus (L1/L3/L5), four tools (spec 10.2), collapsed status (spec 14.2) | Scaffold, adapt |
| F2 | `damage-control.ts` + `damage-control-continue.ts` | Tool-layer permissions (L6, spec 13.1) | Mechanism, invert logic |
| F3 | `subagent-widget.ts` / `tool-counter-widget.ts` | herdr status line format (spec 14) | Reference only |
| F4 | `agent-team.ts` / `agent-chain.ts` | Supervisor dispatch (L9) | Reference only, wrong shape |
| F5 | `purpose-gate.ts` | Startup preview + confirm (spec 5.5) | Reference only |
| F6 | `coms-net.ts`, `cross-agent.ts`, `system-select.ts`, `tilldone.ts`, rest | — | Skip (out of v1 or N/A) |

## Extract these (concrete code)

### From `coms.ts`

- `readOneLine` + `connHandler` + `LINE_CAP_BYTES` (64KB) -> L1 `jsonl-framer.ts`.
  Working JSONL framing with the oversize-frame guard the spec 9.4 red tests need.
- `probeStaleSocket` + `bindEndpoint` (connect-probe, unlink on `ECONNREFUSED`)
  -> L1 socket lifecycle stale-cleanup (spec 10.1, steps 2-3).
- `ulid()` -> event `id` generation.
- `pendingReplies` map + `setTimeout`/`unref` + resolve-on-response -> starting
  point for L3 `correlation-registry.ts`. It keys by `msg_id`; rename to
  `correlationId` and make it the single authority.
- Tool surface shape (`coms_list/send/get/await`) -> `list_agents` /
  `send_prompt` / `await_response`. `send`+`await` is the blocking path,
  `send`+`get` the poll path.

### From `damage-control.ts`

- Interception mechanism: `pi.on("tool_call", ...)` returning `{ block, reason }`,
  with `isToolCallEventType("bash"|"read"|"write"|"edit", event)`. This is the
  Pi API that enforces permissions at the tool layer, which spec 13.1 asserts
  but does not name.
- `damage-control-continue` return shape (block with feedback, turn keeps
  running) -> use for permission denials so the peer adapts instead of hanging.
  Matches the F2 rule: fail the request rather than let it hang.
- `pi.appendEntry("<name>-log", {...})` -> `conversation.jsonl` /
  `tool-calls.jsonl` writer (spec 14.6).

## Risks if lifted naively

- **R1 topology mismatch.** `coms` runs one socket per agent and every agent
  listens; peers discover each other through `~/.pi/coms/` registry files. Our
  spec is one in-process bus inside the supervisor that peers connect to. The
  registry/discovery half of `coms` does not transfer. Take the framing and
  socket-lifecycle code, drop the discovery model.
- **R2 no validation rigor.** `coms` has no Zod, no `correlationId`, no canonical
  event enum. Its `isValidEnvelope` is a hand-rolled type guard. Treat its
  envelope as reference, not our `a2a-schema.ts`.
- **R3 permission polarity inverted.** `damage-control` is a denylist (block
  known-bad patterns). Ours is allowlist / default-deny (shell blocked unless
  `shell_allowlist` matches). Reuse the hook and path-matcher helpers, rewrite
  the decision as default-deny.
- **R4 absent entirely.** No ACK retry/dedupe (L3), no file locks (L6), no budget
  accounting (L7). Build those from the plan.

## Pi API confirmed by these files (de-risks Phase 0)

- `pi.on("tool_call", ...)` returns `{ block: boolean, reason?: string }` to
  allow/deny a tool call. Permission enforcement point.
- `pi.appendEntry(logName, obj)` writes structured JSONL. Our persistent logs.
- `pi.registerTool` / `pi.registerFlag` / `pi.registerCommand`.
- `ctx.ui.setWidget` / `ctx.ui.setStatus` / `ctx.ui.notify` / `ctx.ui.confirm`.
- Peer-turn mechanics (how a WORK_ORDER enters a peer and a RESPONSE comes back):
  - `pi.sendMessage(msg, { deliverAs: "followUp", triggerTurn: true })` injects a
    prompt and starts the peer's turn.
  - `pi.on("agent_end", ...)` + `ctx.sessionManager.getBranch()` reads the last
    assistant message, which `coms` packages as the response. This is our
    RESPONSE / FINAL_REPORT capture.

That pair is the Phase 0 spike already half-done.
