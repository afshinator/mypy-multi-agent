# Multi-Agent Orchestration System
## Product Description and v1.6 Functional Specification
**Status:** v1.6 FINAL product specification; implementation-ready

---

## 1. Product Description

This product is a local-first multi-agent orchestration system for software-engineering work.

A user launches one interactive **Supervisor Agent**. The supervisor reads a declarative session configuration, starts a set of specialized peer agents, assigns each peer a bounded work order, and coordinates the session until the global Definition of Done (DoD) is satisfied or the run is terminated.

Peer agents execute independently in `herdr`-managed terminal panes. They may communicate directly with one another through a local Agent-to-Agent (A2A) message bus rather than routing every interaction through the supervisor. The supervisor remains responsible for work decomposition, reconciliation, resource oversight, failure awareness, and final session completion.

The system is intended to make autonomous multi-agent engineering work visible and controllable without requiring the user to manually coordinate every peer.

### 1.1 Core product characteristics

- **Local-first execution:** agent processes and A2A communication run locally by default.
- **Single-session configuration:** a `session.yaml` file defines the ask, DoD, agents, models, capabilities, limits, permissions, and resource allowances.
- **One interactive control surface:** the user interacts only with the supervisor session.
- **Visible peer execution:** peers run in separate `herdr` panes that can be expanded for detail or collapsed to status lines.
- **Peer-to-peer collaboration:** peers can directly query or command other agents through A2A tools.
- **Supervisor reconciliation:** agent completion alone does not end a run; the supervisor determines whether the aggregate result satisfies the session DoD.
- **Dynamic reactivation:** a peer that has completed its own work can return to work if another peer asks it a follow-up question.
- **Resource guardrails:** token and cost usage are tracked during execution, including per-agent budget controls.
- **Controlled source modification:** write-capable agents announce edit intent before modifying files so other writers are aware.
- **Fault visibility:** crashed peers are surfaced to the supervisor and the UI.
- **User emergency stop:** the user can terminate the active network from the supervisor session.

---

## 2. Goals

### G1. Autonomous decomposition and execution
Allow a supervisor agent to decompose a global engineering task into peer-specific work orders and coordinate completion without requiring the user to manually prompt each peer.

### G2. Specialized parallel work
Allow multiple specialized agents to work concurrently with separate models, prompts, capabilities, restrictions, and budgets.

### G3. Direct peer collaboration
Allow peer agents to communicate directly over the A2A bus so the supervisor does not become a routing bottleneck.

### G4. Explicit completion semantics
Require both:
1. peer-level completion of assigned work, and
2. supervisor-level confirmation that the global DoD is satisfied.

### G5. Observable execution
Expose peer state, current task, cost, token usage, failures, and detailed terminal output through `herdr`.

### G6. Controlled resource consumption
Track live cost/token usage and prevent an individual peer from consuming its full configured allowance without producing a final answer.

### G7. Safe concurrent code modification
Require explicit write privileges and edit-intent broadcasting before an agent modifies source files.

---

## 3. Non-Goals / Not Yet Defined

The source material does **not** yet establish the following as product requirements:

- cloud-hosted orchestration;
- a browser GUI;
- remote multi-user control;
- durable distributed execution;
- automatic crash retry;
- automatic rollback of conflicting source edits;
- a formal approval workflow before every write;
- a specific source-control strategy;
- a final report format;
- session resume/recovery after supervisor or daemon restart.

Some of these may be desirable, but they should not be assumed until explicitly defined.

---

## 4. System Components

| Component | Responsibility | Current mechanism |
|---|---|---|
| `session.yaml` | Session definition and agent configuration | YAML |
| Supervisor Agent | Task decomposition, dispatch, steering, reconciliation, user interaction | `pi` CLI |
| Peer Agents | Specialized task execution and peer collaboration | headless Pi SDK processes |
| `herdr` | Process/pane lifecycle, terminal visibility, status presentation | Rust daemon + CLI/IPC |
| A2A Bus | Local inter-agent messaging | Unix domain socket server, in-process in the supervisor extension |
| A2A Extension | Registers peer communication tools and enforces selected runtime rules | TypeScript `a2a.ts` extension |
| Schema Validation | Validates configuration and/or bus messages | TypeScript + Zod |

---

## 5. User Experience

### 5.1 Confirmed UX behavior

1. The user launches the primary supervisor `pi` session and points it at a `session.yaml`.
2. The supervisor validates/reads the session configuration.
3. The supervisor starts peer agents in managed `herdr` panes.
4. The user interacts only with the supervisor terminal.
5. Peer panes are read-only from the user's perspective.
6. The user can observe peer execution.
7. `herdr` supports:
   - **Expanded mode:** detailed peer terminal/model output and tool activity.
   - **Collapsed mode:** one-line status per peer.
8. The user can issue an emergency `stop`/`abort` action in the supervisor session to terminate active peers and tear down the network.
9. During execution, status lines can expose state, task, live cost, token usage, and exceptional conditions such as `CRASHED` or a forced best-guess response.

Example collapsed status:

```text
[architect] WORKING | $0.41 / $0.50 (82%) | 34,210 tokens | Task: Validating JWT Spec
[sec_auditor] DONE | $0.18 / $0.30 (60%) | 14,800 tokens | [BEST_GUESS_ANSWER emitted]
[code_fixer] CRASHED | $0.05 / $0.40 (12%) | 4,100 tokens | Connection Terminated
```

### 5.2 End-to-end user journey

The v1 user journey is defined:

1. user starts a normal `pi` session;
2. user invokes `/mypi-multi-agent [optional/path/to/session.yaml]`;
3. the extension loads and validates the ask configuration;
4. it shows the ask preview, configured agents, and budgets;
5. the user confirms launch;
6. the extension starts the A2A bus and peer agents in `herdr`;
7. the user interacts only through the supervisor;
8. peers deliberate, collaborate, edit when permitted, and report status;
9. the supervisor reconciles progress against the ask/DoD;
10. on success or global-budget finalization, the session enters `FINALIZING`;
11. peers gracefully conclude and collapse to `DONE`;
12. the supervisor writes `final.md` and reports the result to the user.

## 5.3 Canonical workspace model

The user creates one directory per ask/problem. The directory may live inside or beside a coding project.

```text
project-root/
  src/
  ...
  architecture-review/
    session.yaml
    conversation.jsonl
    tool-calls.jsonl
    final.md
    ...other files created by agents or supervisor
```

The ask is defined in `session.yaml`.

For coding work, the ask directory does not need to contain the source tree. The supervisor/system instructions may point agents at source code elsewhere in the project.

There is no archive prompt and no separate history directory in v1. The working directory itself is the run record.

### 5.4 Slash commands

The custom extension exposes:

```text
/mypi-multi-agent [optional/path/to/session.yaml]
/stop-all
/stop <agent-name>
/kill-all
```

Behavior:

- `/mypi-multi-agent` defaults to `./session.yaml`.
- The optional argument overrides the config path.
- `/stop-all` sends `STOP_ALL` over the bus; each peer aborts its in-flight turn, disposes its session, and exits 0, and the supervisor aborts its own turn. Peers are marked `STOPPED`, not `CRASHED`.
- `/stop <agent-name>` sends `STOP_AGENT` to that peer with the same graceful abort-and-exit behavior.
- `/kill-all` sends `KILL_ALL`: peers terminate immediately (no abort) and the supervisor aborts its own turn.
- A peer stopped with `/stop` is `STOPPED`; it does not reactivate. `FINALIZING` still gates new work.

### 5.5 Startup confirmation

After `session.yaml` validates, but before peers are started, the extension displays:

- global budget;
- per-agent budgets;
- each agent's effective bound: `$X` when priced, `N tokens` when free with `max_tokens`, and an explicit `unpriced` marker when a model has no catalog price;
- the first one or two lines of the ask;
- configured agent names/roles/models.

When all agents are unpriced, the preview also shows a one-line notice that cost limits are not enforced and token ceilings apply. The user must confirm launch. If validation fails, no peers are started.


## 6. Session Configuration

### 6.1 Configuration principle

The canonical top-level schema key for the user problem is `ask`. `task` is not a valid alias and must be rejected as an unknown top-level field.

A session uses one declarative `session.yaml` rather than a collection of fragmented role/task Markdown files.

The configuration must represent:

- session identity;
- the `ask` block containing the problem/question and global Definition of Done;
- global Definition of Done;
- agent registry;
- model per agent;
- agent title/role;
- system prompt;
- capabilities;
- limits/restrictions;
- source-edit permission;
- per-agent cost allowance;
- workspace information if required;
- bus configuration if configurable.

### 6.2 Consolidated draft schema

The example below uses the canonical `ask:` key. The validator in Section 6.3 must accept this example structure and must reject a top-level `task:` key as unknown.

`version` below identifies the **`session.yaml` configuration schema version**. It is independent of this product-spec document version.

This schema represents the union of confirmed requirements. Fields marked `OPEN` require a product decision.

```yaml
version: "1.1"

session:
  id: "sec-audit-01"
  workspace_root: "./"
  max_cost_usd: 5.00
  agent_stop_threshold_percent: 85

ask:
  title: "Security & Architecture Review"
  description: >
    Review JWT authentication middleware in ./src/auth.ts.
  definition_of_done: >
    Produce a reconciled result covering architectural trade-offs,
    security vulnerabilities, and required code/test recommendations.

agents:
  - id: "architect"
    title: "System Architect"
    model: "deepseek/deepseek-v4-pro"

    capabilities:
      - "System design"
      - "Performance trade-offs"
      - "State management"

    limits:
      - "Does not write production unit tests"
      - "Does not produce exploit payloads"

    permissions:
      read: true
      edit: false
      shell: false

    max_cost_usd: 1.00
    max_tokens: 250000

    system_prompt: >
      You are the System Architect. Analyze designs for scalability.

  - id: "code_fixer"
    title: "Code Fixer"
    model: "deepseek/deepseek-r1"

    capabilities:
      - "Implementation"

    limits: []

    permissions:
      read: true
      edit: true
      shell: true

    max_cost_usd: 0.50

    system_prompt: >
      You are the Code Fixer. Implement approved patches.

bus:
  transport: "unix"
  socket_path: "<ask-directory>/.a2a-agent-bus.sock"
  heartbeat_interval_ms: 1000
```

### 6.3 Configuration validation

`session.yaml` validation is strict and deterministic.

No A2A bus, peer process, or `herdr` pane may start until validation passes.

#### 6.3.1 Required top-level fields

```yaml
version:
session:
ask:
agents:
```

#### 6.3.2 Required `session` fields

```yaml
session:
  id:
  max_cost_usd:
  agent_stop_threshold_percent:
```

#### 6.3.3 Required `ask` fields

```yaml
ask:
  title:
  description:
  definition_of_done:
```

#### 6.3.4 Required per-agent fields

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

#### 6.3.5 Optional fields

Optional configuration may include:

- `workspace_root`;
- `capabilities`;
- `limits`;
- `validation`;
- `bus`;
- per-agent `max_tokens` (positive integer, total input+output tokens over the run);
- explicit custom model pricing;
- session/role-specific read-only shell allowlists where needed.

#### 6.3.6 Validation rules

The validator must reject:

- missing required fields;
- wrong field types;
- duplicate agent IDs;
- duplicate session IDs where applicable to the active process;
- unknown permission keys;
- unknown top-level fields;
- invalid percentages;
- negative or zero budgets where a positive value is required;
- a free-model agent (no catalog price and no explicit config price) that has no `max_tokens`;
- negative or zero `max_tokens`;
- invalid model configuration;
- invalid socket/bus configuration;
- malformed validation command configuration.

Unknown fields are rejected by default. Forward compatibility requires an explicit configuration-schema version change.

#### 6.3.7 Human-readable errors

Example:

```text
session.yaml validation failed

agents[1].model
  required field missing

session.agent_stop_threshold_percent
  expected number between 1 and 100, got 120

unknown field
  agents[0].can_edit_code
```

#### 6.3.8 Machine-readable error representation

Internally, validation failures use structured data:

```json
{
  "code": "CONFIG_VALIDATION_FAILED",
  "errors": [
    {
      "path": "agents[1].model",
      "reason": "required"
    }
  ]
}
```

A validation failure exits startup with process exit code `3`.

## 7. Runtime Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                       session.yaml                            │
│ ask + DoD + agents + models + budgets + privileges           │
└──────────────────────────────┬────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────┐
│                    Supervisor pi Agent                        │
│ interactive user surface                                     │
│ dispatch + steering + reconciliation + resource oversight     │
└───────────────┬──────────────────────────────▲────────────────┘
                │                              │
                │ work orders / control        │ reports / intents
                ▼                              │
┌───────────────────────────────────────────────────────────────┐
│                 Local A2A Socket Bus                          │
│              <ask-directory>/.a2a-agent-bus.sock                          │
└───────────────▲──────────────────────────────▲────────────────┘
                │                              │
        peer dialogue                    peer dialogue
                │                              │
                ▼                              ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│ Peer Agent A             │◄─────►│ Peer Agent B             │
│ herdr pane / Pi SDK proc │       │ herdr pane / Pi SDK proc │
└──────────────────────────┘       └──────────────────────────┘
```

### 7.1 Responsibility boundaries

**Supervisor**
- parses session configuration;
- starts peers;
- creates initial work orders;
- receives ACKs and status/completion reports;
- steers/reassigns follow-up work;
- reconciles aggregate results against global DoD;
- receives edit intents;
- receives crash/failure notifications;
- exposes the user's interactive control surface;
- decides when the session is complete.

**Peer**
- accepts a bounded work order;
- ACKs receipt;
- performs assigned work;
- collaborates directly with peers;
- reports state/results;
- announces edit intent before writing when authorized;
- reports completion;
- may reactivate if queried after completion;
- maintains a single persistent session and memory for the whole ask; state is
  not reset between work orders, prompts, or follow-ups.

**A2A Bus**
- transports structured local messages;
- tracks/returns peer presence and state as required by A2A tools;
- routes peer, supervisor, failure, and intent messages.

**`herdr`**
- starts/manages peer processes or panes;
- exposes process state;
- supplies expanded and collapsed UI views;
- detects or surfaces process termination/crash;
- supports network teardown initiated by supervisor/user.

---

## 8. Lifecycle and State Machine

### 8.1 Session lifecycle

```text
CONFIG_LOAD
   │
   ▼
VALIDATE
   │
   ▼
START_BUS
   │
   ▼
SPAWN_PEERS
   │
   ▼
DISPATCH_WORK_ORDERS
   │
   ▼
AWAIT_ACKS
   │
   ▼
EXECUTE / COLLABORATE
   │
   ▼
PEER_COMPLETION_REPORTS
   │
   ▼
SUPERVISOR_RECONCILIATION
   ├── gaps/contradictions ──> STEER / REDISPATCH ──> EXECUTE
   │
   └── DoD satisfied ────────> SESSION_COMPLETE
```

Emergency or fault paths may move the session to an aborted/degraded terminal state.

### 8.2 Canonical state model

v1 uses one agent-state vocabulary:

```text
STARTING
PENDING
WORKING
WAITING
DONE
CRASHED
STOPPED
```

Meanings:

- `STARTING`: process/pane exists but registration and initialization are not complete.
- `PENDING`: registered and available but has not begun the assigned work order.
- `WORKING`: actively executing assigned work.
- `WAITING`: blocked on another agent, a lock, or an awaited response.
- `DONE`: completed current work and reported results; may reactivate unless the session is `FINALIZING`.
- `CRASHED`: process/runtime failure detected.
- `STOPPED`: intentionally terminated without graceful completion.

`FINALIZING` is a **session state**, not an agent state.

The alternate vocabulary `IN_PROGRESS`, `COMPLETED`, and `FAILED` is not used in v1.

### 8.3 Peer completion

A peer is considered locally complete when:

1. it believes its assigned local DoD is satisfied;
2. it sends its result to the supervisor; and
3. it emits an explicit completion status.

Earlier text describes:

```text
[STATUS: DONE]
```

The protocol should eventually use a structured typed status rather than depend on parsing a text token, unless the token is retained only as a display convention.

### 8.4 Reactivation

A peer in `DONE` is not permanently terminated.

If another peer sends it a new prompt:

```text
DONE -> WORKING
```

The peer processes the request, responds, and then reevaluates whether it can return to `DONE`.

### 8.5 Session completion

The supervisor may determine that the ask is satisfied even while one or more peers are still `WORKING`.

When that happens:

1. the supervisor enters `FINALIZING`;
2. it issues graceful stop behavior equivalent to `/stop-all`;
3. active peers abort their in-flight turns and exit;
4. no new peer work is created;
5. `DONE` peers do not reactivate;
6. the supervisor performs final reconciliation;
7. `final.md` is written;
8. the supervisor reports the result to the user.

A crashed or unavailable peer does not automatically block success if the supervisor can still satisfy the ask.

---

## 9. Work Orders

Every initial peer assignment is a **Work Order** generated by the supervisor.

A work order must identify at least:

- task/work-order ID;
- target peer;
- requested action or objective;
- relevant context/files;
- constraints;
- local Definition of Done.

The work-order payload shape:

```ts
{
  taskId: string;
  action: string;
  contextFiles: string[];
  constraints: string[];
}
```

The local DoD and target agent are carried by the outer `WORK_ORDER` envelope.

### 9.1 ACK requirement

A peer must explicitly acknowledge receipt of a work order before the supervisor treats the assignment as accepted.

Rules:

- ACK timeout: **10 seconds**.
- Retry count: **2 retries** after the initial delivery attempt.
- Maximum total delivery attempts: **3**.
- Each retry reuses the same work-order ID and correlation ID so duplicate execution can be detected.
- If all attempts fail:
  - if the peer process is dead/unreachable, mark it `CRASHED`;
  - if the process is alive but dispatch still fails, surface a dispatch failure to the supervisor;
  - the supervisor may reassign that work to another peer;
  - the session continues if the ask can still be satisfied.

A peer must treat a repeated `WORK_ORDER` with the same work-order ID as a duplicate and must not execute it twice.

## 10. Agent-to-Agent Protocol

### 10.1 Transport

Confirmed v1 baseline:

- in-process Unix domain socket server, running inside the supervisor extension;
- Unix domain socket;
- JSON Lines over streaming socket connections;
- local IPC only in v1.

The preferred socket path is session-local:

```text
<ask-directory>/.a2a-agent-bus.sock
```

The extension derives the ask directory from the selected `session.yaml`.

Socket lifecycle:

1. determine the preferred session-local socket path;
2. if a socket entry already exists, verify whether a live bus owns it;
3. delete stale socket entries before binding;
4. bind and use the socket for the run;
5. on normal teardown, close the bus and remove the socket entry;
6. on `/kill-all`, close/remove the socket as part of teardown;
7. after an abnormal crash, the next launch performs stale-socket cleanup.

Because Unix-domain socket paths have platform length limits, the extension must automatically fall back when the preferred path is too long:

```text
$TMPDIR/mypi-<hash-of-absolute-ask-directory>.sock
```

The fallback is internal. The user does not configure it.

TCP/WebSocket/LAN transport is outside v1.

### 10.2 Agent tools

The `pi` A2A extension registers the following tools:

| Tool | Purpose |
|---|---|
| `list_agents` | Return known peer ids and state |
| `dispatch_work_order` | Assign a peer a concrete task with a checkable local DoD |
| `collect_reports` | Read pending `FINAL_REPORT`s from peers |
| `send_prompt` | Send a conversational request to another peer |
| `await_response` | Wait for an incoming response/message |

### 10.3 Typed envelopes and canonical event types

All A2A messages are typed and validated before processing.

Canonical v1 event types:

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

`HALT` is not part of the v1 enum because graceful stop and immediate kill are intentionally distinct operations.

Every envelope must include at least:

```ts
{
  id: string;             // unique event id
  correlationId?: string; // request/response grouping
  timestamp: number;
  sender: string;
  recipient: string | "all";
  type: EventType;
  payload: unknown;
}
```

Required payload schemas must exist for every canonical event type above.

### 10.3.1 Correlation and duplicate handling

- request/response pairs use `correlationId`;
- retried work orders keep the same work-order ID/correlation ID;
- duplicate `WORK_ORDER` delivery must not trigger duplicate execution;
- duplicate ACK/response events may be ignored after first successful processing.

### 10.3.1.1 Peer model-call retry

A work order whose turn ends empty or errored (intermittent upstream/connection
failure) is retried by the peer itself before any report reaches the supervisor:

- `peer_max_retries` (default 3) retries after the first failed turn;
- `peer_retry_pause_ms` (default 30000) pause before each retry;
- the retried prompt tells the model its previous response was empty/errored;
- the peer reports only after retries are exhausted or a turn succeeds.

This covers transient transport/model errors; a peer process crash is still
handled by heartbeat/disconnect (Section 10.3.2), not by this retry.

### 10.3.2 Heartbeat and disconnect

- peers emit periodic `HEARTBEAT` events while alive;
- loss of heartbeat beyond the configured disconnect threshold marks the peer unreachable;
- if the process is confirmed dead, transition it to `CRASHED`;
- locks owned by that peer are released immediately.

### 10.4 Malformed-message handling

All bytes received from the A2A socket are validated before they can reach agent logic.

Malformed input is divided into two failure classes because the bus can trust different information in each case.

#### 10.4.1 Class F1: unparseable frame or invalid envelope

This class includes:

- a JSON Lines frame that is not valid JSON;
- an outer envelope missing required fields such as `id`, `sender`, or `type`;
- an envelope that otherwise cannot be parsed into the canonical message-envelope schema.

Handling:

1. do not enter agent logic;
2. log a protocol-failure record to `conversation.jsonl`;
3. increment a per-connection malformed-message counter;
4. drop the frame;
5. do **not** emit an `ERROR` reply because sender identity and correlation metadata are not trustworthy;
6. never retry the malformed frame.

For F1 logging, record only transport-safe metadata by default:

- timestamp;
- connection ID;
- byte length;
- parse/validation error;
- optional bounded diagnostic excerpt if safe.

Do not persist arbitrary raw malformed bytes by default.

#### 10.4.2 Class F2: valid envelope, invalid event type or payload

This class includes:

- an outer envelope that parses successfully but uses a `type` outside the canonical event enum;
- a known event type whose `payload` fails that event type's Zod schema.

Handling:

1. do not enter agent logic;
2. emit exactly one `ERROR` event back to the parsed `sender`;
3. preserve the original `correlationId` when present;
4. include:
   - a machine-readable validation error code;
   - a human-readable validation reason;
5. log the validation failure to `conversation.jsonl`;
6. fail the sender's pending request / `await_response` rather than allowing it to hang until timeout;
7. never retry the malformed message automatically.

#### 10.4.3 Repeat malformed sender / connection

To prevent a looping or broken peer from flooding the bus:

- threshold: **5 malformed messages within 60 seconds** per connection/peer;
- when the threshold is crossed, the bus emits a supervisor-visible protocol-fault event;
- the supervisor may issue `STOP_AGENT`;
- the malformed counter resets or decays after the 60-second window.

#### 10.4.4 Global malformed-message invariants

For all malformed-message classes:

- malformed traffic is always logged;
- malformed traffic never reaches agent logic;
- malformed traffic never triggers automatic retry.


## 11. Supervisor Reconciliation and Steering

The supervisor does not simply wait for all peers to finish.

It must:

1. aggregate incoming peer results;
2. compare them to the global DoD;
3. identify gaps, contradictions, or incomplete work;
4. issue targeted follow-up prompts or new work orders;
5. continue the loop until the global DoD is satisfied or the session terminates for another reason.

This is the central orchestration loop.

### 11.1 Peer collaboration topology

Peer-to-peer communication is first-class. The supervisor coordinates the session but is not required to relay every peer message.

### 11.2 Supervisor authority

The supervisor can:

- dispatch work;
- steer peers;
- receive status;
- reconcile output;
- receive and rebroadcast edit intents;
- redistribute unfinished work from a failed peer to another existing peer;
- enter session finalization;
- terminate the peer network.

v1 does **not** support:

- pausing an individual peer as a first-class lifecycle operation;
- restarting a crashed peer process;
- automatically spawning a replacement process;
- restoring a crashed peer's process state.

If a peer crashes, it remains `CRASHED`. The supervisor may continue with remaining peers and may reassign the unfinished work.

## 12. Cost and Token Controls

### 12.1 Pricing source and accounting

The primary pricing source is Pi's resolved model catalog/model metadata for the active provider/model.

Rules:

- input/output token usage is tracked per agent;
- cost is computed from the resolved model's pricing metadata;
- the supervisor's token/cost usage **counts toward the global session budget**;
- peer costs count toward both their own per-agent limit and the global session budget;
- a model used in a budget-enforced run with no catalog pricing metadata is treated as **free**: token usage is still tracked per agent, cost is 0, and cost-based thresholds never trigger for that agent;
- explicit pricing may still be supplied in configuration to meter a model the catalog does not price.

When a priced model returns a response without usage numbers, the runtime does not record zero. It uses the harness-local token count for that call if available; otherwise it logs a usage-gap event to `conversation.jsonl` and counts the call as 0 cost but marks that agent's accounting as incomplete. Missing usage is never silently treated as zero for threshold math.

Custom model pricing may be supplied explicitly in the applicable Pi model configuration or session configuration.

### 12.2 Per-agent limits

Each peer has:

```yaml
max_cost_usd: <number>
max_tokens: <integer>   # optional; required when the model is free
```

`max_cost_usd` is a dollar allowance; `max_tokens` is a raw token count (total input+output over the run). They are distinct fields and are not overloaded. There is no minimum per-agent budget in v1.

`max_tokens` is the cost-independent bound: it applies to every agent regardless of pricing. If an agent resolves to free (no catalog price, no explicit config price) and has no `max_tokens`, validation fails at startup with exit code 3.

### 12.3 Shared graceful-stop threshold

The session defines one source-of-truth threshold:

```yaml
session:
  max_cost_usd: 5.00
  agent_stop_threshold_percent: 85
```

The default is `85`, but it is editable.

When a peer reaches that percentage of its own `max_cost_usd`, or that same percentage of its `max_tokens` (when set), whichever trips first, the system applies behavior equivalent to:

```text
/stop <agent-name>
```

The two thresholds are OR'd: cost and token bounds are checked independently and the first one to reach `agent_stop_threshold_percent` triggers the stop.

The peer:

1. stops starting new work;
2. finishes its current synthesis/report;
3. may exceed the percentage threshold while doing so;
4. reports to the supervisor;
5. becomes `DONE`.

Outside session-wide finalization, that `DONE` peer may later reactivate.

### 12.4 Global session limit

`session.max_cost_usd` includes the supervisor and all peers.

Free agents contribute 0 to the global dollar limit. When any agent is free, the global dollar limit is not a total-compute ceiling: token ceilings (`max_tokens`) are the operative bound for those agents, and the global limit governs only priced usage.

When the global limit is reached:

1. the session enters `FINALIZING`;
2. behavior equivalent to `/stop-all` is issued;
3. no new peer work is created;
4. active peers abort their in-flight turns and exit;
5. `DONE` peers do not reactivate;
6. the supervisor performs final reconciliation;
7. a bounded overrun is allowed for final synthesis/reporting;
8. the supervisor writes `final.md`.

The global limit does **not** broadcast an immediate hard `HALT`.

`/kill-all` is the explicit immediate termination mechanism.

### 12.5 Finalization overrun

A bounded overrun is allowed only after `FINALIZING` begins.

The exact grace bound remains implementation-configurable, but it must be finite and enforced by the extension. If that grace is exhausted, remaining peer execution is stopped and the supervisor produces the best available final result with the incomplete condition recorded in `final.md`.

## 13. Code Modification and Permission Model

### 13.1 Tool-level permissions

v1 uses explicit tool capabilities rather than `can_edit_code`:

```yaml
permissions:
  read: true
  edit: false
  shell: false
```

Semantics:

- `read`: file-reading/search access, plus `web_fetch` (read-only web research:
  http/https fetches returning truncated text).
- `edit`: file mutation through edit/write tools.
- `shell`: shell execution.

Permissions are enforced by the extension/tool layer, not only by agent prompts.

An agent without `edit` permission cannot use file edit/write tools.

A read-only agent should normally use `shell: false`. If a read-only role requires shell access, only explicitly allowlisted non-mutating commands are permitted. v1 does not attempt to infer whether arbitrary shell commands are safe.

### 13.2 Edit intent

Before any authorized file mutation, the agent emits `intent_to_modify` containing at least:

- agent ID;
- target file path;
- proposed change/intent.

The supervisor broadcasts the intent to other agents with `permissions.edit: true`.

### 13.3 Exact-file locking

v1 uses exact-file locks with deadlock prevention.

Rules:

- lock granularity: exact file path;
- acquisition ordering: FIFO per file;
- acquisition timeout: **30 seconds**;
- one agent may hold **at most one write lock at a time**;
- an agent must release its current write lock before requesting another;
- locks are released immediately when:
  - the writer completes the mutation,
  - the writer explicitly releases the lock,
  - the writer crashes,
  - the writer disconnects,
  - the writer is killed/stopped;
- the supervisor/bus reconciles lock ownership against the live-agent registry after heartbeat loss;
- stale locks are removed during that reconciliation;
- directory/subtree locking is outside v1.

The one-lock-per-agent rule removes multi-file circular wait and therefore prevents the primary write-lock deadlock class in v1.

## 14. `herdr` UI and Observability

### 14.1 Expanded mode

Displays detailed peer execution in separate panes, including terminal/model output and tool activity.

### 14.2 Collapsed mode

Displays a one-line summary per agent.

Minimum useful fields established in the later spec:

- agent ID/name;
- runtime state;
- current cost / max cost;
- percentage of allowance used;
- token count;
- current task or status detail;
- exceptional marker such as best-guess or crash.

### 14.3 State examples

```text
[architect] WORKING...
[sec_auditor] WAITING...
[architect] DONE...
[code_fixer] CRASHED...
```

### 14.4 Status update mechanism

`herdr pane report-metadata` is the authoritative mechanism for agent status.

Rules:

- the peer harness updates agent state through `herdr pane report-metadata`;
- the canonical A2A state is carried as a token (`--token state=<STATE>`); live cost and token counts are tokens too (`--token cost=...`, `--token tokens=...`), and task/status detail goes in `--title`;
- `--state-label` is reserved for `herdr`'s own lifecycle states (`idle`/`working`/`blocked`/`done`/`unknown`) and is not used for canonical state;
- self-report covers live states (`STARTING`, `PENDING`, `WORKING`, `WAITING`, `DONE`); `CRASHED` and `STOPPED` are never self-reported — `CRASHED` comes from `herdr` exit detection and heartbeat loss (Section 10.3.2), `STOPPED` from the supervisor/control plane;
- collapsed status UI is rendered from that structured state;
- agent stdout is not parsed as the source of truth for state;
- OSC escape sequences may be used internally by `herdr` as a rendering implementation detail, but extensions and agents do not depend on OSC directly.

### 14.5 Logs

Each peer has its own process/terminal stream.

Persistent orchestration logging is defined in Section 14.6. Long-term retention/rotation policy remains outside v1.

---

## 14.6 Persistent run files

The ask directory itself is the persistent run record.

### `conversation.jsonl`

Append-only orchestration log containing:

- work orders;
- ACKs;
- peer prompts and responses;
- supervisor prompts and responses;
- state transitions;
- edit intents;
- file-lock events;
- crash/failure events;
- stop/kill commands;
- budget events;
- finalization/completion events.

Tool calls are kept separately.

### `tool-calls.jsonl`

Append-only tool execution log containing:

- timestamp;
- agent;
- tool name;
- call/correlation ID;
- arguments or summarized arguments;
- result metadata;
- error/failure information;
- duration when available.

### `final.md`

Always written on normal successful completion.

Its body format depends on the ask. Run metadata is stored in YAML frontmatter, including at minimum:

```yaml
---
run_id: "<timestamp-or-run-id>"
started_at: "<timestamp>"
completed_at: "<timestamp>"
status: "completed"
total_cost_usd: 0.00
total_tokens: 0
agents:
  - name: "architect"
    model: "..."
    cost_usd: 0.00
    tokens: 0
    final_state: "DONE"
---
```

Additional files created by agents or the supervisor remain in the same ask directory.


## 15. Failure and Termination Behavior

### 15.1 Peer crash

If a peer process crashes or encounters an unhandled runtime failure:

1. `herdr` marks the pane/agent `CRASHED`;
2. a failure packet is sent onto the A2A bus;
3. the supervisor is notified.

### 15.2 Crash handling

When a peer becomes `CRASHED`:

1. the supervisor is notified;
2. the session continues if the ask can still be satisfied;
3. the supervisor may redistribute the crashed peer's unfinished work;
4. v1 does not automatically restart the crashed process;
5. if the supervisor determines the ask cannot be satisfied, it reports failure rather than pretending success.

### 15.3 User abort and escalation

The system distinguishes graceful convergence from abort.

Control semantics:

- `/stop-all` requests graceful convergence.
- `/kill-all` immediately terminates all non-supervisor processes.
- if the supervisor/session itself is exited while peers remain active, the system follows the abort path below.

Abort path:

1. issue graceful stop behavior to all active peers (they abort their in-flight turns and exit);
2. allow a **10-second grace period** for peers to abort and exit;
3. after 10 seconds, force-kill any remaining non-supervisor processes;
4. close the A2A bus;
5. remove the session socket;
6. preserve `conversation.jsonl`, `tool-calls.jsonl`, and any other files already written;
7. ensure `final.md` exists.

If the run is aborted before a normal final result exists, `final.md` must still be created with:

```yaml
---
status: "aborted"
completed_at: "<timestamp>"
total_cost_usd: 0.00
total_tokens: 0
agents:
  - name: "<agent>"
    final_state: "<state>"
abort_reason: "<reason>"
---
```

The body should contain a short best-available summary of what completed before the abort.

Process exit codes:

```text
0 = successful completion
1 = session failed / DoD not satisfied
2 = user-aborted
3 = config/startup failure
```

### 15.4 Global budget termination

Global budget exhaustion follows Section 12.4.

The session enters `FINALIZING` and performs graceful `/stop-all` behavior with bounded synthesis grace. It does not immediately broadcast a hard halt.

## 16. Validation and Determinism

### 16.1 Strict protocol validation

All A2A socket messages are validated using Zod before processing.

Rules:

- malformed or schema-invalid payloads never enter normal agent logic;
- validation failures are handled according to Section 10.4;
- schemas are versioned with the protocol;
- canonical event types are defined in Section 10.3;
- each canonical event type must have a concrete payload schema.

### 16.2 Code-change validation gates

Validation gates are **configurable and apply only to runs that change code**.

Example:

```yaml
validation:
  required_for_code_changes: true
  commands:
    - "npm test"
    - "npm run lint"
```

Rules:

- if `validation` is absent, semantic DoD reconciliation alone determines success;
- if validation is configured and code was changed, the configured commands must pass for the run to be marked successful;
- validation commands are executed only after code-changing work is ready for reconciliation;
- semantic DoD and mechanical validation are both required when validation is enabled;
- if validation fails, the supervisor may send targeted follow-up work while budget/time permits;
- if the run cannot satisfy validation before finalization, the supervisor reports partial/failure status rather than marking success.

Validation is not mandatory for analysis-only or non-code-changing asks.

## 17. Remaining Implementation Details

The core v1 orchestration path is frozen. The following items may be deferred without blocking v1:

- TCP/WebSocket/LAN transport;
- automatic process restart;
- session resume/recovery;
- macOS-specific separate-window launch mechanics;
- long-term log retention/rotation policy.

Implementation still needs concrete Zod schemas for the already-canonical A2A event types, but the required event enum and runtime behavior are now defined.

## 18. Decisions Baseline

1. Local-only Unix-domain-socket execution.
2. Preferred session-local socket: `<ask-directory>/.a2a-agent-bus.sock`, with automatic `$TMPDIR` hashed fallback for path-length limits.
3. One `session.yaml` per ask directory.
4. One interactive supervisor `pi` session.
5. N read-only-from-user peer panes managed by `herdr`, each running a headless Pi SDK process.
6. Supervisor-created work orders with local DoD and explicit ACK.
7. ACK timeout of 10 seconds, 2 retries, duplicate-safe work-order IDs.
8. Direct peer-to-peer messaging through the A2A bus.
9. Canonical agent states: `STARTING`, `PENDING`, `WORKING`, `WAITING`, `DONE`, `CRASHED`, `STOPPED`.
10. `FINALIZING` as a session-level state.
11. Reactivation of normally `DONE` peers except during `FINALIZING`.
12. Supervisor reconciliation until the ask/global DoD is satisfied.
13. Per-agent `max_cost_usd` (dollar bound) and optional `max_tokens` (token bound); `max_tokens` is required when the agent's model is free.
14. Global `session.max_cost_usd`, including supervisor usage; free agents contribute 0.
15. Shared `agent_stop_threshold_percent`, default `85`, applied as an OR over cost% and token% — whichever trips first stops the agent.
16. Global-limit graceful `/stop-all` finalization with finite synthesis grace.
17. Pi-resolved model pricing as the primary pricing source; models without catalog pricing are free (cost 0, tokens still tracked).
18. Explicit `read` / `edit` / `shell` permissions enforced at the tool layer.
19. Pre-write `INTENT_TO_MODIFY` plus exact-file FIFO locking.
20. One write lock maximum per agent, 30-second acquisition timeout, crash/disconnect release.
21. Crash notification, degraded continuation, and supervisor redistribution without automatic restart.
22. `/stop-all`, `/stop <agent-name>`, and `/kill-all`.
23. Expanded and collapsed `herdr` visibility.
24. `conversation.jsonl`, `tool-calls.jsonl`, and `final.md` persisted in the ask directory.
25. `final.md` YAML frontmatter contains run metadata.
26. Configurable validation gates for code-changing tasks only.
27. Successful completion collapses peers to `DONE`.
28. Canonical typed A2A event enum defined in Section 10.3.
29. Malformed A2A traffic handling defined in Section 10.4, including F1/F2 separation and repeat-offender thresholds.
30. User abort uses 10-second graceful shutdown, then force-kill, artifact preservation, final abort record, and deterministic exit codes.
31. Structured `herdr pane report-metadata` state labels/tokens are the authoritative status mechanism.
32. Peer pause/restart/replacement processes are outside v1; unfinished work may be reassigned to existing peers.
33. `session.yaml` validation is strict, rejects unknown fields, and prevents startup on failure.
34. A priced call that returns no usage numbers logs a usage-gap and does not silently zero threshold math.
35. Startup preview shows each agent's effective bound (`$X`, `N tokens`, or `unpriced`).
36. A free-model agent without `max_tokens` fails validation with exit code 3.

Outside v1:
- TCP/WebSocket/LAN mode;
- automatic process restart;
- session resume/recovery;
- mandatory universal validation;
- separate history/archive directory.

## 19. Successful Teardown Behavior

On normal success:

1. supervisor enters `FINALIZING`;
2. active peers are gracefully stopped;
3. no new peer work is created;
4. `DONE` peers do not reactivate;
5. peers report final conclusions;
6. `final.md` is written;
7. the supervisor reports back according to the ask;
8. peer panes collapse to `DONE` and remain visible until the user exits the multi-agent extension/session.

`/kill-all` remains an immediate non-graceful termination path for non-supervisor processes.
