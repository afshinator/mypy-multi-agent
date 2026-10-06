# Multi-Agent Orchestration System
## Implementation Plan v5

**Status:** Build-ready TDD implementation plan  
**Companion specification:** `multi-agent-spec-v1.6.md`  
**Execution model:** Solo development

---

## 1. Purpose

This document defines the dependency-ordered, test-driven implementation plan for the multi-agent orchestration system.

The product specification defines what the system must do.

This implementation plan defines:

- what to build first;
- which tests must exist before implementation;
- module ownership;
- executable contracts;
- dependency order;
- failure-path coverage;
- exit criteria for every layer.

The implementation rule is:

```text
RED → GREEN → REFACTOR
```

No runtime behavior is considered implemented unless its test existed first and failed for the expected reason.

No constant may remain undecided at the point its test is written.

---

## 2. Inputs Required by the Implementer

The implementation requires:

1. `multi-agent-spec-v1.6.md`
2. this implementation plan
3. access to the installed Pi APIs/source, including the Pi SDK (`docs/sdk.md`) used as the peer harness
4. access to the installed `herdr` APIs/source

The two documents define:

- product behavior;
- runtime contracts;
- lifecycle;
- protocol semantics;
- configuration semantics;
- failure handling;
- implementation order;
- acceptance criteria.

They do not replace external API contracts.

Before production integration, verify the actual installed interfaces for:

- Pi extension registration;
- Pi slash-command registration;
- Pi tool interception;
- Pi model/pricing metadata;
- `herdr` pane creation;
- `herdr` process termination;
- `herdr pane report-metadata` structured state/status (`--state-label`, `--token`, `--title`);
- Pi SDK `createAgentSession()` + `session.subscribe()` as the peer harness.

If installed APIs differ materially from assumptions in the specification, adapt the implementation while preserving specified behavior.

---

# 3. TDD Operating Rules

## 3.1 Tests come first

Every implementation unit follows:

1. write the smallest failing test;
2. confirm the failure is for the intended missing behavior;
3. implement the minimum code required to pass;
4. refactor without changing externally observable behavior;
5. rerun the affected contract, integration, and failure suites.

## 3.2 No undecided constants

All values needed by tests are decided before the relevant test is written.

## 3.3 Three test categories per layer

Every layer must include:

- **contract tests**
- **integration tests**
- **failure-path tests**

A layer is incomplete if only the happy path passes.

## 3.4 External systems stay behind adapters

Pi and `herdr` integrations must sit behind local interfaces so deterministic tests do not require real LLM calls or real terminal processes except where explicitly required.

## 3.5 Solo sequencing

This project is developed by one implementer.

Phase 0 investigation and contract-schema work may be interleaved, but both must be complete before L1 begins.

Thereafter, implementation proceeds strictly:

```text
L1 → L2 → L3 → L4 → L5 → L6 → L7 → L8 → L9 → L10 → L11
```

---

# 4. Implementation Principles

## 4.1 Executable contracts first

Before runtime behavior, implement:

```text
src/contracts/session-schema.ts
src/contracts/a2a-schema.ts
```

They are the executable source of truth for configuration and protocol validation.

No component maintains duplicate handwritten interfaces for schema-derived structures.

Types are inferred from Zod.

```ts
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type A2AEnvelope = z.infer<typeof A2AEnvelopeSchema>;
```

## 4.2 Deterministic runtime before live models

Use mock peers until transport, lifecycle, retries, locking, budgeting, and control behavior are proven.

Live LLM-backed Pi peers are not required to validate orchestration correctness.

## 4.3 Policy and transport stay separate

The A2A runtime owns:

- transport;
- framing;
- validation;
- connection identity;
- routing;
- runtime state facts;
- heartbeats;
- locks;
- budget enforcement signals.

The supervisor owns:

- decomposition;
- reasoning;
- work assignment;
- semantic Definition-of-Done evaluation;
- reconciliation;
- final response generation.

The bus must not decide whether the ask is satisfied.

## 4.4 Observable from the beginning

Persistent event logging begins in L1.

Every later layer must be debuggable from structured logs.

## 4.5 One authority per cross-cutting concern

Cross-cutting behavior must not be implemented twice.

### Correlation

Single authority:

```text
src/runtime/correlation-registry.ts
```

Responsibilities:

- open waiter;
- resolve by `correlationId`;
- fail by `correlationId`;
- timeout.

Built in L3. Reused by L5.

### Exit codes

Single authority:

```text
src/runtime/exit.ts
```

All four process exit codes are defined there and nowhere else.

### Session state

Single authority:

```text
src/control/session-state.ts
```

All readers observe this state. Only designated control/finalization code mutates it.

---

# 5. Decided Constants

| Constant | Value | Config field |
|---|---:|---|
| ACK timeout | 10,000 ms | fixed |
| ACK retries | 2 retries / 3 attempts total | fixed |
| Lock acquisition timeout | 30,000 ms | fixed |
| Max write locks per agent | 1 | fixed |
| Malformed-message threshold | 5 within 60,000 ms | fixed |
| Heartbeat interval | 1,000 ms | `bus.heartbeat_interval_ms` |
| Heartbeat timeout | 3,000 ms | `session.heartbeat_timeout_ms` |
| User-abort grace | 10,000 ms | fixed |
| Agent graceful-stop threshold | 85% | `session.agent_stop_threshold_percent` |
| Per-agent token ceiling | positive integer; required when model is free | `agents[].max_tokens` |
| Finalization cost grace | 10% of `session.max_cost_usd` | `session.finalization_grace_usd` |
| Finalization time grace | 30,000 ms | `session.finalization_grace_ms` |

Rules:

```text
heartbeat_timeout_ms >= 2 × heartbeat_interval_ms
```

Finalization grace ends when **either** cost grace or time grace is exhausted.

---

# 6. Phase 0: Pi ↔ `herdr` Integration Spike

## 6.1 Objective

Prove the riskiest external integration before runtime architecture depends on it.

This is a spike, not production orchestration.

## 6.2 Required proof

From a Pi extension or minimal TypeScript harness:

1. create a `herdr` peer pane/process;
2. launch a deterministic fake peer;
3. push structured state through `herdr pane report-metadata` (`--state-label`, `--token`, `--title`);
4. render collapsed state;
5. inspect expanded view;
6. demonstrate representative transitions:

```text
STARTING → WORKING → WAITING → DONE
```

This is illustrative, not the complete canonical state set. Production must also support `PENDING`, `CRASHED`, and `STOPPED`.

7. terminate the pane/process cleanly.

## 6.3 Adapter contract test

Before real integration code, write a failing adapter test for:

- create pane;
- set state;
- map pane/process to agent ID;
- terminate pane.

A fake adapter may satisfy the local contract first.

## 6.4 Acceptance

PASS when one fake peer can be created, state-updated, observed, and terminated through the Pi-side integration boundary.

If installed `herdr` cannot satisfy the required behavior, resolve that before L1.

---

# 7. Contract Layer

The two schema files are written before runtime implementation.

---

## 7.1 `session-schema.ts`

### Objective

Encode the canonical `session.yaml` contract.

### Required top-level fields

```yaml
version:
session:
ask:
agents:
```

### Required `session` fields

```yaml
session:
  id:
  max_cost_usd:
  agent_stop_threshold_percent:
```

### Optional session fields with defaults

```yaml
session:
  heartbeat_timeout_ms: 3000
  finalization_grace_usd: <10% of max_cost_usd>
  finalization_grace_ms: 30000
```

### Required `ask`

```yaml
ask:
  title:
  description:
  definition_of_done:
```

### Required agent fields

```yaml
agents:
  - id:
    title:
    model:
    permissions:
      read:
      edit:
      shell:
    max_cost_usd:
    system_prompt:
```

### Optional agent field

```yaml
agents:
  - max_tokens: <integer>   # required when the model is free
```

`max_tokens` is shape-optional (positive integer). The D2 rule (a free agent requires it) is enforced by a validation function that receives the resolved per-agent pricing, not by the pure Zod schema; the red test injects a stub pricing resolver. `session-schema.ts` stays free of pricing knowledge.

### Optional shell allowlist

```yaml
shell_allowlist:
  - "git status"
  - "git diff"
```

Rules:

- only valid when `permissions.shell: true`;
- if `shell: true` and `edit: false`, shell commands are limited to this allowlist;
- if that mode has no allowlist, no shell command is permitted.

### Red tests first

1. minimal valid config;
2. full valid config;
3. missing required top-level field;
4. unknown top-level field;
5. `task:` rejected;
6. duplicate agent IDs;
7. invalid permission key;
8. invalid stop threshold;
9. invalid budget;
10. heartbeat timeout defaults to 3000;
11. heartbeat timeout below 2× interval rejected;
12. finalization grace time defaults to 30000;
13. finalization grace cost defaults to 10%;
14. allowlist with `shell: false` rejected;
15. allowlist with `shell: true` accepted;
16. `max_tokens` accepted for a priced agent;
17. free agent without `max_tokens` rejected;
18. free agent with `max_tokens` accepted;
19. negative or zero `max_tokens` rejected.

Only then implement the schema.

### Deliverables

```text
src/contracts/session-schema.ts
test/contracts/session-schema.test.ts
```

### Exit criterion

All schema tests pass and the specification's example config validates unchanged.

---

## 7.2 `a2a-schema.ts`

### Objective

Encode one canonical envelope and one concrete payload schema per event type.

### Event enum

```text
AGENT_REGISTER
AGENT_REGISTERED
WORK_ORDER
ACK
PROMPT
RESPONSE
STATUS
STATE_CHANGED
INTENT_TO_MODIFY
LOCK_REQUEST
LOCK_ACQUIRED
LOCK_RELEASED
AGENT_CRASHED
BUDGET_THRESHOLD
STOP_AGENT
STOP_ALL
KILL_ALL
FINAL_REPORT
ERROR
HEARTBEAT
```

### Envelope

```ts
{
  id: string;
  correlationId?: string;
  timestamp: number;
  sender: string;
  recipient: string | "all";
  type: EventType;
  payload: unknown;
}
```

### Red tests first

For every event:

- one valid payload;
- one invalid payload.

Also test:

- missing envelope field;
- unknown event type;
- invalid recipient;
- malformed sender;
- optional `correlationId`.

Only then implement.

### Deliverables

```text
src/contracts/a2a-schema.ts
test/contracts/a2a-schema.test.ts
```

### Exit criterion

Every event has a concrete Zod payload schema and inferred TypeScript type.

---

# 8. Dependency Graph

```text
Phase 0: Pi ↔ herdr spike ───────┐
                                  ├──> L1
Contract schemas + tests ─────────┘
                                       │
                                       ▼
                                      L2
                                       │
                                       ▼
                                      L3
                                       │
                                       ▼
                                      L4
                                       │
                                       ▼
                                      L5
                                       │
                                       ▼
                                      L6
                                       │
                                       ▼
                                      L7
                                       │
                                       ▼
                                      L8
                                       │
                                       ▼
                                      L9
                                       │
                                       ▼
                                     L10
                                       │
                                       ▼
                                     L11
```

Solo execution is sequential after both prerequisites are complete.

---

# 9. L1: Socket, JSONL Framing, Validation, and Logging

## 9.1 Objective

Build the local Unix-socket protocol producer layer without depending on higher-level consumers.

## 9.2 Suggested modules

```text
src/bus/socket-server.ts
src/bus/jsonl-framer.ts
src/bus/message-validator.ts
src/bus/router.ts
src/logging/conversation-log.ts
src/logging/tool-call-log.ts
```

## 9.3 Socket lifecycle

Red tests first for:

- session-local path;
- stale socket cleanup;
- fallback path;
- teardown deletion.

Paths:

```text
preferred: <ask-directory>/.a2a-agent-bus.sock
fallback:  $TMPDIR/mypi-<hash-of-absolute-ask-directory>.sock
```

## 9.4 JSONL framing

Red tests:

- one frame per read;
- multiple frames in one read;
- frame split across reads;
- empty lines;
- partial frame on disconnect;
- invalid JSON.

## 9.5 Malformed-message ownership

L1 owns only producer behavior.

### F1: unparseable frame / invalid envelope

L1 must:

- log transport-safe metadata;
- increment malformed counter;
- drop;
- emit no reply;
- never retry.

### F2: valid envelope / invalid payload

L1 must:

- emit exactly one correlated `ERROR`;
- log;
- drop before agent logic;
- call a pending-request failure seam;
- never retry.

Use:

```ts
interface PendingRequestFailureSink {
  fail(correlationId: string, reason: string): void;
}
```

L1 only asserts that this seam is called.

### Repeat offender

At:

```text
5 malformed messages / 60 seconds
```

L1 emits a protocol-fault event to a fault sink/bus.

L1 does not decide whether the peer is stopped.

## 9.6 Logging

Create append-only:

```text
conversation.jsonl
tool-calls.jsonl
```

## 9.7 Red tests first

Contract:

- frame parsing;
- envelope validation;
- malformed classification.

Integration:

- mock clients;
- valid route;
- logging;
- correlated ERROR.

Failure:

- fragmented invalid JSON;
- invalid payload;
- malformed threshold;
- partial disconnect;
- stale socket.

## 9.8 Exit criterion

Malformed input produces exactly the required F1/F2 log, counter, `ERROR`, and protocol-fault emission behavior.

Higher-layer consumption is not claimed complete here.

---

# 10. L2: Registration, Heartbeat, Identity, and State Registry

## 10.1 Objective

Associate connections with trusted agent identities and maintain runtime state facts.

## 10.2 Suggested modules

```text
src/runtime/agent-registry.ts
src/runtime/heartbeat-monitor.ts
src/runtime/state-machine.ts
src/runtime/connection-identity.ts
```

## 10.3 Connection identity

After `AGENT_REGISTER`:

```text
connection → registered agent ID
```

Subsequent sender mismatch is rejected before agent logic.

## 10.4 Canonical states

```text
STARTING
PENDING
WORKING
WAITING
DONE
CRASHED
STOPPED
```

`FINALIZING` is session state only.

## 10.5 Heartbeat behavior

Default:

```text
heartbeat_interval_ms = 1000
heartbeat_timeout_ms  = 3000
```

Three missed default heartbeats make a peer unreachable.

## 10.6 Red tests first

- valid registration;
- duplicate registration;
- sender mismatch;
- valid transitions;
- invalid transitions;
- healthy heartbeat never flips;
- silence to timeout → `CRASHED`;
- crash event emitted.

## 10.7 Exit criterion

The runtime can trust connection identity and deterministically detect heartbeat failure at the configured threshold.

---

# 11. L3: Correlation Registry, Work Orders, ACK, Retry, and Deduplication

## 11.1 Objective

Build the single correlation authority and use it for reliable work-order dispatch.

## 11.2 Suggested modules

```text
src/runtime/correlation-registry.ts
src/runtime/work-order-manager.ts
src/runtime/retry-policy.ts
```

## 11.3 Correlation contract

```ts
interface CorrelationRegistry {
  open(correlationId: string, timeoutMs: number): Promise<A2AEnvelope>;
  resolve(correlationId: string, msg: A2AEnvelope): void;
  fail(correlationId: string, reason: string): void;
}
```

## 11.4 Red tests first

Correlation:

1. matching resolve completes waiter;
2. non-matching ID does not;
3. timeout rejects;
4. `fail()` rejects immediately;
5. second resolve is safe/ignored.

Work orders:

- ACK first try;
- ACK after retry;
- no ACK;
- crash before ACK;
- late duplicate ACK;
- duplicate work order re-ACKs but executes once.

## 11.5 Delivery semantics

```text
ACK timeout: 10 seconds
retries: 2
total attempts: 3
```

IDs are stable across retries.

## 11.6 F2 cross-layer behavior

Red integration test:

> correlated F2 `ERROR` for an in-flight work order fails the correlation immediately instead of waiting the ACK timeout.

Wire L1's failure seam to `CorrelationRegistry.fail()`.

## 11.7 Exit criterion

The runtime provides:

```text
retried at-least-once delivery
+
at-most-once execution per work-order ID
```

---

# 12. L4: Control Plane

## 12.1 Objective

Implement bus-level lifecycle signals and session/mock state.

## 12.2 Suggested modules

```text
src/control/control-plane.ts
src/control/stop-manager.ts
src/control/kill-manager.ts
src/control/session-state.ts
```

## 12.3 Scope boundary

L4 is signal-only with respect to OS processes.

L4:

- emits `STOP_AGENT`;
- emits `STOP_ALL`;
- emits `KILL_ALL`;
- mutates canonical session state;
- drives mock-peer behavior.

Real process termination belongs to L8.

L4 does **not** own supervisor policy for protocol faults.

## 12.4 Red tests first

- stop one peer;
- stop all;
- enter `FINALIZING`;
- reject new work during `FINALIZING`;
- no DONE reactivation during `FINALIZING`;
- kill all emits signal;
- mock peers exit on kill.

## 12.5 Exit criterion

Control semantics are proven on the bus and against mock peers without claiming real process termination.

---

# 13. L5: Peer Collaboration and Reactivation

## 13.1 Objective

Implement direct peer `PROMPT`/`RESPONSE` using L3's correlation registry.

## 13.2 Suggested modules

```text
src/runtime/peer-messaging.ts
src/pi/a2a-tools.ts
```

No second correlator exists.

## 13.3 Required tools

```text
list_agents
send_command
send_prompt
await_response
```

## 13.4 Reactivation

Outside `FINALIZING`:

```text
DONE + incoming PROMPT → WORKING
```

During `FINALIZING`:

```text
DONE stays DONE
```

## 13.5 Red tests first

- PROMPT opens correlation;
- RESPONSE resolves;
- peer-to-peer response succeeds;
- DONE peer reactivates;
- target crash fails request;
- FINALIZING prevents reactivation.

## 13.6 Exit criterion

Peer collaboration works through the one correlation registry with no duplicate timeout subsystem.

---

# 14. L6: Permissions, Shell Allowlist, Edit Intent, and File Locking

## 14.1 Objective

Own all tool permission and concurrent-write enforcement.

## 14.2 Suggested modules

```text
src/pi/tool-permissions.ts
src/locks/file-lock-manager.ts
src/locks/edit-intent-manager.ts
```

## 14.3 Permission behavior

### Shell off

```text
shell: false
```

Blocks all shell calls.

### Shell on, edit off

```text
shell: true
edit: false
```

Only allowlisted shell commands are permitted.

### Edit off

Blocks edit/write tools.

Do not infer arbitrary shell safety.

## 14.4 Red permission tests

1. shell off blocks;
2. shell on/edit off allows allowlisted command;
3. non-allowlisted command blocks;
4. obvious mutating unlisted command blocks;
5. edit off blocks write;
6. edit on reaches lock path.

## 14.5 Lock rules

```text
granularity: exact file
ordering: FIFO
acquisition timeout: 30 seconds
max locks per agent: 1
```

Flow:

1. permission check;
2. emit `INTENT_TO_MODIFY`;
3. request lock;
4. wait FIFO;
5. acquire;
6. mutate;
7. release.

## 14.6 Automatic release tests

Red tests first for:

- normal completion;
- explicit release;
- crash;
- disconnect;
- stop;
- kill.

Also test:

- second writer waits;
- FIFO ordering;
- second lock request rejected while first held;
- acquisition timeout.

## 14.7 Exit criterion

Permissions cannot be bypassed through shell/tool selection, and concurrent writers cannot deadlock or mutate the same file simultaneously.

---

# 15. L7: Usage and Budget Accounting

## 15.1 Objective

Implement deterministic accounting before real paid model usage.

## 15.2 Suggested modules

```text
src/budget/usage-accounting.ts
src/budget/pricing-resolver.ts
src/budget/budget-enforcer.ts
src/pi/pi-usage-adapter.ts
```

## 15.3 Suggested interface

```ts
interface UsageAccounting {
  recordUsage(event: UsageEvent): void;
  getAgentCost(agentId: string): number;
  getSessionCost(): number;
  getAgentTokens(agentId: string): number;
  getSessionTokens(): number;
}
```

## 15.4 Pricing

Primary source:

- Pi resolved model pricing metadata (`ctx.modelRegistry.find(provider, modelId)?.cost`, per-million-token rates).

A model with no catalog pricing is **free**: cost is 0, token usage is still tracked, and cost-based thresholds never trigger for that agent; `max_tokens` is the operative bound. Explicit pricing may be supplied in configuration to meter such a model.

Supervisor usage counts toward global cost.

L7 builds accounting against synthetic `UsageEvent`s injected behind `pi-usage-adapter.ts`; no live Pi wiring is required here. The live wiring — the peer harness forwarding `session.subscribe()` `message.usage` (carrying `totalTokens` and `cost.total`, already computed at catalog price) into the same `UsageEvent` stream — lands in L8. `pi-usage-adapter.ts` is the single entry point both producers feed.

## 15.5 Threshold behavior

Peer threshold is an OR over two bounds, whichever reaches `agent_stop_threshold_percent` first:

- cost%: `agentCost / max_cost_usd` (priced agents);
- token%: `agentTokens / max_tokens` (agents with `max_tokens` set).

Tripping either is equivalent to `/stop <agent>`.

Global max:

```text
FINALIZING
equivalent to /stop-all
```

## 15.6 Finalization grace

Defaults:

```text
cost: 10% of session.max_cost_usd
time: 30,000 ms
```

Execution stops when either bound is exhausted.

## 15.7 Red tests first

- synthetic peer cost;
- supervisor contributes globally;
- peer cost threshold;
- peer token threshold (free model with `max_tokens`);
- whichever-first when both cost and token bounds are set;
- global threshold;
- within grace succeeds;
- cost grace exhausted;
- time grace exhausted;
- incomplete condition recorded;
- free model: cost stays 0, tokens counted, token threshold trips at 85% of `max_tokens`;
- priced call with missing usage logs a usage-gap and does not zero the threshold math.

## 15.8 Exit criterion

Budget behavior is proven entirely with synthetic usage events.

---

# 16. L8: Production `herdr` Integration

## 16.1 Objective

Replace mock process control with real `herdr` pane/process lifecycle, and introduce the real headless peer harness (`src/peer/peer-main.ts`).

## 16.2 Suggested modules

```text
src/herdr/herdr-client.ts
src/herdr/pane-manager.ts
src/herdr/status-adapter.ts
src/peer/peer-main.ts
```

The peer harness embeds Pi via `createAgentSession()`, connects to the A2A socket, runs WORK_ORDERs with `session.prompt()`, forwards `session.subscribe()` events (text deltas, tool activity, `message.usage`) to the bus and to its own stdout, and self-reports collapsed state with `herdr pane report-metadata` using its injected `$HERDR_PANE_ID`.

## 16.3 Required behavior

- spawn peer;
- map pane/process to agent ID;
- publish structured state via `herdr pane report-metadata` (custom `--state-label` values for canonical states, `--token` for cost/tokens);
- show collapsed/expanded views;
- detect exit/crash;
- terminate process;
- collapse successful peer to DONE.

## 16.4 Red real-integration tests

- spawn fake peer;
- update state;
- crash peer;
- observe crash;
- `/kill-all` terminates real processes;
- locks owned by killed processes release;
- `/stop-all` permits graceful conclusion when peer cooperates.

## 16.5 Exit criterion

Control semantics proven in L4 now work against actual `herdr` processes.

---

# 17. L9: Supervisor Reconciliation, Protocol-Fault Policy, Final Reports, and Finalization

## 17.1 Objective

Connect runtime facts to supervisor policy and produce successful/failed completion.

## 17.2 Suggested modules

```text
src/supervisor/work-planner.ts
src/supervisor/reconciliation.ts
src/supervisor/finalization.ts
src/artifacts/final-writer.ts
src/runtime/exit.ts
```

## 17.3 Exit-code authority

`src/runtime/exit.ts` defines:

```text
0 = success
1 = session failed / DoD not satisfied
2 = user-aborted
3 = config/startup failure
```

Red unit test asserts all four constants before implementation.

L9 uses 0 and 1.

L10 uses 2 and 3.

## 17.4 Supervisor responsibilities

- decompose ask;
- dispatch work;
- inspect results;
- capture peer `FINAL_REPORT`;
- detect gaps/contradictions;
- steer/reassign;
- evaluate DoD;
- decide policy response to surfaced protocol faults;
- enter `FINALIZING`;
- collect conclusions;
- write `final.md`.

## 17.5 Protocol-fault ownership

L1 emits protocol-fault information.

L4 provides the `STOP_AGENT` mechanism.

L9 is the single policy owner deciding whether a surfaced protocol fault should trigger `STOP_AGENT`.

Red cross-layer test:

- malformed threshold surfaces peer fault;
- supervisor receives identity/context;
- supervisor chooses stop;
- L4 executes the stop signal.

## 17.6 `FINAL_REPORT`

Red test:

- peer final report arrives;
- reconciliation captures it exactly once.

## 17.7 Final outcomes

### Success

DoD satisfied:

- finalize;
- collect reports;
- write successful `final.md`;
- exit 0.

### Failure

DoD cannot be satisfied:

- write failure/partial artifact;
- exit 1.

## 17.8 Red tests first

- all peers succeed;
- DoD fails;
- peer crash + reassignment;
- contradictory results trigger follow-up;
- satisfied while peer still WORKING;
- global budget triggers finalization;
- final report captured;
- protocol fault can cause supervisor-directed stop.

## 17.9 Exit criterion

The supervisor can deterministically produce exit 0/1, consume final reports, and own protocol-fault policy.

---

# 18. L10: User Abort and Startup Failure

## 18.1 Objective

Implement the two non-normal exit paths.

## 18.2 Ownership

L10 uses:

```text
2 = user-aborted
3 = config/startup failure
```

All constants come from `src/runtime/exit.ts`.

## 18.3 User abort

Flow:

1. graceful stop;
2. wait 10 seconds;
3. force-kill remaining peers;
4. close bus;
5. remove socket;
6. preserve artifacts;
7. ensure aborted `final.md`;
8. exit 2.

## 18.4 Startup failure

Includes:

- invalid config;
- unrecoverable startup failure (e.g., socket/bus cannot start).

Result:

```text
exit 3
```

No peer processes may remain.

## 18.5 Red tests first

- graceful abort;
- forced kill after timeout;
- artifacts preserved;
- socket removed;
- aborted final file;
- exit 2;
- invalid config → exit 3;
- bus/socket startup failure → exit 3.

## 18.6 Exit criterion

Abort and startup failures leave deterministic artifacts and use only the shared exit-code authority.

---

# 19. L11: Code-Change Validation Gates

## 19.1 Objective

Apply configured mechanical validation only when relevant.

## 19.2 Suggested modules

```text
src/validation/validation-runner.ts
src/validation/change-detector.ts
```

## 19.3 Behavior

No validation config:

```text
semantic DoD only
```

Validation configured but no code changed:

```text
skip code-change gate
```

Validation configured and code changed:

```text
semantic DoD
AND
configured commands pass
```

## 19.4 Red tests first

- no validation;
- validation/no code change;
- code changed/pass;
- fail then repaired;
- still failing at finalization → no success.

## 19.5 Exit criterion

A code-changing run cannot exit successfully while required configured validation fails.

---

# 20. Deterministic Mock Peer Harness

The mock peer exists from L1 onward.

It must support:

- registration;
- heartbeat;
- ACK;
- delayed ACK;
- missing ACK;
- work execution count;
- duplicate re-ACK without duplicate execution;
- state changes;
- peer PROMPT/RESPONSE;
- reactivation;
- lock request/release;
- deliberate crash;
- disconnect;
- malformed JSON;
- invalid payload;
- ignored graceful stop;
- exit on kill;
- synthetic usage;
- `FINAL_REPORT`.

Its purpose is deterministic failure injection.

---

# 21. Test Organization

```text
test/
  contracts/
  unit/
  integration/
  failure/
  fixtures/
  mock-peer/
  herdr/
  end-to-end/
```

Every behavior begins as a red test in the narrowest appropriate suite.

---

# 22. Suggested Repository Structure

```text
src/
  contracts/
    session-schema.ts
    a2a-schema.ts

  bus/
    socket-server.ts
    jsonl-framer.ts
    message-validator.ts
    router.ts

  runtime/
    agent-registry.ts
    connection-identity.ts
    heartbeat-monitor.ts
    state-machine.ts
    correlation-registry.ts
    work-order-manager.ts
    retry-policy.ts
    peer-messaging.ts
    exit.ts

  control/
    control-plane.ts
    stop-manager.ts
    kill-manager.ts
    session-state.ts

  locks/
    file-lock-manager.ts
    edit-intent-manager.ts

  budget/
    usage-accounting.ts
    pricing-resolver.ts
    budget-enforcer.ts

  herdr/
    herdr-client.ts
    pane-manager.ts
    status-adapter.ts

  supervisor/
    work-planner.ts
    reconciliation.ts
    finalization.ts

  validation/
    validation-runner.ts
    change-detector.ts

  logging/
    conversation-log.ts
    tool-call-log.ts

  artifacts/
    final-writer.ts

  pi/
    extension.ts
    slash-commands.ts
    a2a-tools.ts
    tool-permissions.ts
    pi-usage-adapter.ts

  peer/
    peer-main.ts
```

There is no separate `pending-requests.ts` or `response-correlator.ts`.

Correlation belongs only to:

```text
src/runtime/correlation-registry.ts
```

---

# 23. Pi Extension Assembly

Only after L1-L10 are green should the production extension be assembled.

## 23.1 Slash commands

```text
/mypi-multi-agent
/stop-all
/stop <agent-name>
/kill-all
```

## 23.2 A2A tools

```text
list_agents
send_command
send_prompt
await_response
```

## 23.3 Startup sequence

```text
resolve session.yaml
        │
        ▼
validate schema
        │
        ├─ fail → exit 3
        │
        ▼
resolve pricing
        │
        ▼ free if model has no catalog price
enforce free-agent bound (free agent requires `max_tokens`)
        │
        ├─ missing → exit 3
        │
        ▼
show ask/agents/budgets
        │
        ▼
user confirms
        │
        ▼
resolve socket
        │
        ▼
start bus   ← in `session_start`, never the extension factory
        │
        ▼
spawn peers
        │
        ▼
register + heartbeat
        │
        ▼
dispatch work
```

---

# 24. End-to-End TDD Acceptance

The end-to-end test is written before final production assembly and initially fails.

## 24.1 Fixture

Use a disposable coding project with:

- supervisor;
- read-only reviewer;
- edit-capable peer;
- another peer to exercise collaboration.

## 24.2 Required successful behavior

1. config validates;
2. defaults materialize;
3. startup preview displays;
4. confirmation starts runtime;
5. bus starts;
6. `herdr` panes start;
7. peers register;
8. heartbeat stays healthy;
9. work orders dispatch;
10. ACK resolves through `CorrelationRegistry`;
11. duplicate work order re-ACKs and executes once;
12. peer request resolves through same registry;
13. state updates appear through `herdr pane report-metadata`;
14. edit intent emits;
15. file lock acquires;
16. permissions enforce;
17. source change occurs;
18. tool calls log;
19. orchestration events log;
20. validation passes if configured;
21. peer `FINAL_REPORT` enters reconciliation;
22. supervisor satisfies DoD;
23. finalization stays within grace;
24. peers collapse to DONE;
25. socket is removed;
26. `final.md` exists with metadata;
27. process exits 0.

## 24.3 Required failure scenarios

- ACK exhaustion;
- F2 ERROR fails pending ACK immediately;
- heartbeat timeout;
- malformed threshold → supervisor-visible fault → supervisor-directed stop;
- crash + lock release;
- work reassignment;
- permission denial;
- lock contention;
- peer budget threshold;
- global budget finalization;
- finalization cost grace exhaustion;
- finalization time grace exhaustion;
- validation failure;
- user abort;
- `/kill-all`;
- config/startup exit 3;
- free-agent token-threshold stop;
- free agent without `max_tokens` → config/startup exit 3.

---

# 25. Build Order

## Step 1: Schemas and constants

Write red tests for:

- heartbeat defaults/validation;
- finalization-grace defaults;
- shell allowlist;
- strict config;
- all A2A payloads.

Implement until green.

## Step 2: Phase 0 adapter proof

Write adapter contract tests, then prove the actual Pi↔`herdr` boundary.

Both Step 1 and Step 2 must be complete before L1.

## Step 3: L1

Red → green → refactor for framing, malformed classes, logs, sinks, and protocol-fault emission.

## Step 4: L2

Red → green → refactor for registration, identity, states, heartbeat.

## Step 5: L3

Red → green → refactor for correlation, ACK, retries, F2 failure wiring, and deduplication.

## Step 6: L4

Red → green → refactor for control signals and session state.

## Step 7: L5

Red → green → refactor for peer messaging and reactivation.

## Step 8: L6

Red → green → refactor for permissions, shell allowlist, intent, locks.

## Step 9: L7

Red → green → refactor for accounting, pricing, thresholds, grace bounds.

## Step 10: L8

Red real-integration tests → green → refactor for actual `herdr` lifecycle.

## Step 11: L9

Red → green → refactor for reconciliation, protocol-fault policy, final reports, finalization, exit 0/1.

## Step 12: L10

Red → green → refactor for abort/startup cleanup and exit 2/3.

## Step 13: L11

Red → green → refactor for validation gates.

## Step 14: End-to-end

Run the already-written failing E2E suite against production assembly until green.

---

# 26. Definition of Implementation Complete

v1 implementation is complete when:

- both schema files are production source of truth;
- Phase 0 integration proof passes;
- L1-L11 each complete red→green→refactor;
- all contract tests pass;
- all integration tests pass;
- all failure-path tests pass;
- deterministic mock-peer suite passes;
- real Pi/`herdr` end-to-end test passes;
- required failure scenarios pass;
- generated run artifacts match the specification;
- no production behavior relies on undocumented prompt conventions;
- no test-required constant remains implicit or duplicated;
- correlation, exit codes, session state, and protocol-fault policy each have exactly one authority.

The implementation then conforms to `multi-agent-spec-v1.6.md` and this plan.
