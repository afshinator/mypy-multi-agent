# 10 Levels of Jev for Agentic Engineers

Based on the video tutorial and the official repository [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev), this guide outlines the progression from simple program-controlled decision logic to an autonomous AI agent leveraging Jev on demand.

---

## Overview: What is Jev?

**Jev** (developed by TypeSafe) is a fast, lightweight **System 1 decision model**. Instead of generating free-form text like standard LLMs, Jev takes a structured **state** (string, object, array) along with typed questions/rubrics, and returns probability-based decisions in around ~300ms for a fraction of a cent.

### Core Philosophy:

- **Levels 1 to 5:** Code calls Jev. Jev functions as a smart, probabilistic `if` statement within application logic.
- **Levels 6 to 10:** Jev is integrated into an autonomous coding agent (specifically the `pi` coding agent framework), moving from non-intrusive hooks to active tool calls and self-generated questions.

---

## Summary of the 10 Levels

| Level        | Name / Focus           | Description                                                                                                                | Codebase Path (`src/levels/`)     |
| :----------- | :--------------------- | :------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- |
| **Level 1**  | Single Decisions       | Smart `if` statements (binary yes/no, single choice) for cases regex misses (e.g., prompt injection detection).            | `level1_single_decisions/`        |
| **Level 2**  | Parallel Decisions     | Runs multiple independent decisions across the same state in a single request.                                             | `level2_parallel_decisions/`      |
| **Level 3**  | Threshold Tuning       | Calibrating confidence thresholds (probabilistic boundaries) for safety and execution control.                             | `level3_threshold_tuning/`        |
| **Level 4**  | Structuring State      | Formats inputs into lean, structured JSON/Markdown states to optimize decision accuracy.                                   | `level4_structuring_state/`       |
| **Level 5**  | Agent Pre-flight       | Uses Jev to perform upfront triage, diff evaluation, or request classification before launching a heavy LLM agent.         | `level5_agent_preflight/`         |
| **Level 6**  | Agent Hooks            | Intercepts agent tool execution (e.g., gating destructive Bash commands or external writes) via hooks unseen by the agent. | `level6_agent_hooks/`             |
| **Level 7**  | Context Compaction     | Automatically compresses agent message history based on context window token pressure.                                     | `level7_context_compaction/`      |
| **Level 8**  | Static Tools           | Provides `ask_jev` as a defined tool that the agent can explicitly choose to invoke when uncertain.                        | `level8_static_tools/`            |
| **Level 9**  | Dynamic Tools          | Generates custom, on-the-fly Jev schemas and decision tools tailored to the specific task environment.                     | `level9_dynamic_tools/`           |
| **Level 10** | Agent-Driven Questions | The agent formulates its own questions and evaluation rubrics dynamically to query Jev autonomously.                       | `level10_agent_driven_questions/` |

---

## Detailed Breakdown of Each Level

### Level 1: Single Decisions (Smart `if` Statements)

- **Concept:** Replaces fragile regex or keyword matching with semantic classification.
- **Use Cases:**
  - **Prompt Injection Gate:** Identifies whether input text contains conversational content or attempt instructions.
  - **Urgency Gate:** Triggers page/alert if urgency score exceeds `0.7`.
  - **Ticket Classifier:** Choice classification across core departments with an "Other" fallback.
- **Codebase Reference:** `src/levels/level1_single_decisions/`

### Level 2: Parallel Decisions

- **Concept:** Submits multiple distinct questions within a single API payload over one state vector to maintain minimal latency (~300ms).
- **Use Cases:** Evaluates risk, category, and sentiment simultaneously on customer support incoming state.
- **Codebase Reference:** `src/levels/level2_parallel_decisions/`

### Level 3: Threshold Tuning & Confidence Floors

- **Concept:** Uses probabilities returned by Jev to enforce variable confidence gates depending on action risk.
- **Use Cases:**
  - **Bash Tool Gate:** Classifies commands as `read_only`, `reversible`, or `irreversible`.
  - **Account Actions:** Low-risk `check_balance` runs on default confidence; high-risk `approve_transfer` requires a `0.9` confidence bar to bypass manual confirmation.
  - **Citation Check:** Validates source quotes before rendering.
- **Codebase Reference:** `src/levels/level3_threshold_tuning/`

### Level 4: Structuring State

- **Concept:** Demonstrates how clean formatting of state (e.g., stripping noisy metadata, highlighting git diffs or file paths) improves decision reliability.
- **Codebase Reference:** `src/levels/level4_structuring_state/`

### Level 5: Agent Pre-flight

- **Concept:** Acts as a lightweight front door before orchestrating expensive, long-context agents.
- **Use Cases:**
  - **Failure Triage:** Classifies unit test failures before touching files.
  - **Diff Assessment:** Generates a risk score and `needs_review` flag on `git diff`.
  - **Request Gating:** Routes incoming user instructions to lightweight scripts vs. full sub-agent swarms.
- **Codebase Reference:** `src/levels/level5_agent_preflight/`

### Level 6: Agent Hooks (Gating the Agent)

- **Concept:** Embeds Jev into `pi` agent framework hooks (`beforeToolCall`, `afterToolResult`). The agent is unaware Jev exists; Jev acts as an active safety filter.
- **Gating Examples:**
  - **Destructive Bash Prevention:** Intercepts commands like `rm -rf` or unsafe file exfiltration (`curl`).
  - **Repo Boundary Check:** Blocks unapproved file writes outside the project directory.
- **Codebase Reference:** `apps/ten-levels/extensions/level6_hooks.ts` and `src/levels/level6_agent_hooks/`

### Level 7: Context Compaction Hook

- **Concept:** Monitors agent token usage. When token thresholds are reached (e.g., 6k, 10k, 14k tokens), Jev determines which parts of conversation history can be safely summarized or truncated without loss of execution state.
- **Codebase Reference:** `apps/ten-levels/extensions/level7_compaction.ts` and `src/levels/level7_context_compaction/`

### Level 8: Static Tools (`ask_jev`)

- **Concept:** Exposes Jev directly to the agent as a tool.
- **Key Tool Mentioned:** **`ask_jev`**
  - The agent is provided a structured tool definition (`ask_jev`) with predefined options and can deliberately call it when it wants to evaluate probabilities or verify sanity checks before making decisions.
- **Codebase Reference:** `apps/ten-levels/extensions/level8_static_tools.ts` and `src/levels/level8_static_tools/`

### Level 9: Dynamic Tools

- **Concept:** Rather than relying on a static `ask_jev` definition, the system builds customized tool definitions on the fly based on the specific runtime context and codebase schema.
- **Codebase Reference:** `apps/ten-levels/extensions/level9_dynamic_tools.ts` and `src/levels/level9_dynamic_tools/`

### Level 10: Agent-Driven Questions

- **Concept:** Full agent autonomy. The agent writes its own prompts, rubrics, and structured questions to send to Jev when reasoning through complex problem spaces.
- **Key Tool Mentioned:** **`ask_jev` (Agent-Formulated)**
  - The agent calls `ask_jev` using its own dynamically constructed question payloads and criteria to validate assumptions at negligible token cost.
- **Codebase Reference:** `apps/ten-levels/extensions/level10_agent_driven.ts` and `src/levels/level10_agent_driven_questions/`

---

## Tools and Ecosystem Mentioned in the Video & Codebase

1. **`ask_jev`**:
   - The primary tool interface supplied to the `pi` coding agent starting in Level 8. Allows the agent to query TypeSafe's Jev model for instant decision output.
2. **`pi` Coding Agent**:
   - An extensible, open-source AI agent framework used throughout Levels 6–10 to demonstrate hooks, context compaction, and tool execution.
3. **`ohmyjev`**:
   - Mentioned in the ecosystem context as a production-grade safety & routing plugin for `pi` and Claude Code (`Novacon/ohmyjev`).
4. **TypeSafe / OpenRouter API**:
   - The backing infrastructure for executing Jev decisions (either directly via TypeSafe API keys or routed through OpenRouter as `~typesafe/jev-latest`).
````

I have generated the markdown document reviewing the 10 Levels of Jev, reconciling the video concepts with the `disler/ten-levels-of-jev` codebase, and detailing tools like `ask_jev` and `pi`.```
````
