# 10 Levels of Jev — retired pointer

This file was a second-hand summary of a video and [disler/ten-levels-of-jev](https://github.com/disler/ten-levels-of-jev), written before Jev 1.14. It is kept as a pointer only: it lacks the failure-mode list, the confidence formulas, Box questions, and the repeatability measurements, and it ends with unedited generator text. Do not cite it.

Read instead, in this order:
1. [When to use Jev, and when not](when-to-use-jev.md) — the fit test, thresholds, and the accuracy caveat.
2. [System One](https://docs.typesafe.ai/concepts/system-one) and [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one) — what the model is.
3. [Primitives](https://docs.typesafe.ai/primitives) — Choice, Score, Noul, Box, and their limits.
4. [Model jaggedness](https://docs.typesafe.ai/model-jaggedness) — the nine failure modes and what to do instead.
5. [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook) and [choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook) — the repeatability numbers.
6. [Workflow evals](https://evals.typesafe.ai) — accuracy, cost and latency against LLM prompts and LLM workflows.
7. [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents) — Jev is not a replacement for the model behind your coding agent.

Repo ledger, unchanged: [integration-map.md](integration-map.md), [implementation-plan.md](implementation-plan.md).
