# When to use Jev, and when not

Repo-agnostic. Every claim below carries a link to the page it came from; the local
measurement is cited to the file that recorded it. Vendor pages were read 2026-11-12, the
consistency numbers are `jev-1.14.0` from 2026-11-02, the eval numbers are the ones
published on `evals.typesafe.ai` on that date. Send `jev-latest` and log the `model` field
the response returns; there is no version to pin
([models](https://docs.typesafe.ai/models)).

## What Jev is

A System One model takes a `state` and typed questions and returns typed answers with
probability distributions. It does not generate text, write code, or hold a conversation
([introduction](https://docs.typesafe.ai/introduction),
[coding agents](https://docs.typesafe.ai/introduction/coding-agents)).

| Question                               | Answer                                                                     | Limits                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Noul` — yes/no                        | `noul` in 0–1, no separate `confidence`                                    | — ([noul](https://docs.typesafe.ai/primitives/noul))                                         |
| `Choice` — one of a known set          | picked option, per-option `probabilities`, `confidence`                    | up to 255 options ([choice](https://docs.typesafe.ai/primitives/choice))                     |
| `Score` — position on your rubric      | `score` (can fall between levels), per-level `probabilities`, `confidence` | at least 2, API accepts up to 10 levels ([score](https://docs.typesafe.ai/primitives/score)) |
| `Box` — where something is in an image | four edges as fractions                                                    | 1.14 only ([models](https://docs.typesafe.ai/models))                                        |

Request shape: 64k tokens per request and 32k per question, both raised to 262k by the
`TypeSafe-Danger-Zone-Long-Context: true` header, which is slower and less accurate; $42
per billion input tokens, output free; most calls about 100 ms
([models](https://docs.typesafe.ai/models),
[how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)). The state
is read once and every question is evaluated against it in parallel, so one answer never
becomes hidden context for another
([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)). The model
reads what the request carries, `state` plus any images; it does not open files, call tools,
or hold a conversation
([coding agents](https://docs.typesafe.ai/introduction/coding-agents)).

Calibration is a property of the model, not a check on the answer: "Calibration is measured
across groups of predictions; it does not guarantee that an individual answer is correct"
([system one](https://docs.typesafe.ai/concepts/system-one)).

## "More reliable than asking the LLM" — which reliability

TypeSafe's four workflow evals score each case against consensus labels produced by GPT-6
Astra and Claude Fable 5.1, with the harness assumed correct
([evals](https://evals.typesafe.ai)):

| Configuration              | Mean accuracy | Cost/case      | Time/case |
| -------------------------- | ------------- | -------------- | --------- |
| Jev workflow               | 67.8 %        | $0.0001–0.0011 | 0.3–0.5 s |
| Best LLM workflow (Sol)    | 74.1 %        | $0.03–0.22     | 8.5–34 s  |
| Best LLM workflow (Opus 5) | 73.1 %        | $0.06–0.49     | 15–92 s   |
| Best LLM, one prompt (Sol) | 63.4 %        | $0.05–0.43     | 25–118 s  |

Per workflow, Jev scores 61.7 / 71.6 / 61.8 / 76.0 %
([security](https://evals.typesafe.ai/security_incidents),
[trace](https://evals.typesafe.ai/agent_trace_observability),
[invoice](https://evals.typesafe.ai/invoice_processing),
[customer service](https://evals.typesafe.ai/customer_service)).

Read that table correctly. Jev beats every LLM _prompt_, and loses to the best LLM
_workflows_. The workflow advantage is not Jev's: the same eval has Luna at 51.9 %
prompt versus 66.8 % workflow and Haiku 4.5 at 18.1 % versus 53.6 %, and it states that
"every model is more accurate, cheaper and faster in the workflow than it is with the same
policy as a prompt". Decomposition buys the accuracy. Jev buys repeatability, price and
typing.

Repeatability, measured as the chance that asking the identical borderline input again
changes the decision, counted across every cutoff from 0 to 1, per input's least stable
question, 15 repeats over 40 borderline inputs
([noul cookbook](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook),
[choice cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)):
- Jev: 3.8 % (Noul) and 4.0 % (Choice) average, worst input 8.4 % and 6.7 %.
- In the Noul test, every LLM condition has an input above 10 %; the steadiest are GPT-6.1
  Terra at 6.2 % and Claude Opus 5.5 at 6.4 %, the rest average 7.7 %–34.8 %.
- Temperature 0 narrows the gap and does not close it.

A local measurement on one `Noul` agrees in direction and magnitude: identical input
returned 0.57–0.60 across five runs, a ~0.03 probability spread
([implementation-plan.md E2](implementation-plan.md)).

## Is the question Jev-shaped?

All six. Any failure is a reason to keep the LLM, or to move the work into code.
1. **The answer space is closed and listed in code before the call.** Noul, or a Choice
   over an enumerable set, or a Score over levels you can describe distinctly
   ([primitives](https://docs.typesafe.ai/primitives)).
2. **The judgment is one hop.** No arithmetic, no counting, no date ordering, no property
   of a property, no double negation
   ([jaggedness](https://docs.typesafe.ai/model-jaggedness)).
3. **Everything the answer needs is in `state`.** Jev reads the request, not your disk, your
   tools, or your repo ([state](https://docs.typesafe.ai/concepts/state)). Unrelated detail
   in `state` costs accuracy; filter in code first
   ([jaggedness](https://docs.typesafe.ai/model-jaggedness)).
4. **A wrong answer is cheap, catchable, or has a review path.** Confidence summarises the
   model's own distribution, not its correctness
   ([confidence](https://docs.typesafe.ai/confidence)).
5. **A threshold can sit clear of the flip band** (see the next section).
6. **You can calibrate on labelled examples you own.** "Start with conservative thresholds,
   test with your own data, and adjust as you observe results"
   ([confidence](https://docs.typesafe.ai/confidence)).

## Thresholds

- **Noul: two thresholds, not one.** 0.7 for yes, 0.3 for no, and the 0.3–0.7 band gets its
  own outcome instead of being rounded to a side
  ([noul](https://docs.typesafe.ai/primitives/noul)).
- **Choice and Score: threshold the probability of the option you will act on**, not
  `confidence`. With a fixed option count, `confidence` is a monotone transform of the top
  probability, so checking both adds no independent evidence; a confidence of 0.5 means a
  top probability of 0.75 with two options and 0.55 with ten
  ([confidence](https://docs.typesafe.ai/confidence)).
- **Scale the bar with the cost of being wrong.** Read-only actions can act on a lower bar
  than irreversible ones, and a threshold never substitutes for confirmation: "The
  thresholds only choose which workflow runs; none of them moves money"
  ([confidence](https://docs.typesafe.ai/confidence),
  [probability routing](https://docs.typesafe.ai/patterns/probability-routing)).
- **Choice always picks something.** Add a companion `Noul` ("does any option fit?") to the
  same request rather than an `other` option; TypeSafe reports that the Noul works better
  than `other`, which competes for probability
  ([primitives](https://docs.typesafe.ai/primitives),
  [companion noul](https://docs.typesafe.ai/patterns/companion-noul)).

## Fits

Each row has a worked cookbook or eval behind it
([use case map](https://docs.typesafe.ai/concepts/use-case-map)).
- Intent, category, owner or model routing over a closed set.
- Detecting one property: urgency, spam, injection, PII, "needs a reply", "is a bug".
- Rubric scoring: severity, relevance, quality, frustration, passage relevance.
- Ranking a shortlist, one question per candidate, sorted by probability
  ([re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe)).
- Extraction where code enumerates candidates first and Jev picks the span
  ([date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)).
- Verifying an LLM answer **against source text you put in `state`**
  ([verify outputs](https://docs.typesafe.ai/cookbooks/verify_llm_outputs),
  [citations](https://docs.typesafe.ai/cookbooks/citation_check)).
- Guardrail signal on model input or output, combined with deterministic rules.
- Cheap pre-flight before an expensive step, then ignore the answers that do not apply
  ([fan-out](https://docs.typesafe.ai/patterns/fan-out)).

## Does not fit

Named as failure modes by the vendor, with the workaround it prescribes
([jaggedness](https://docs.typesafe.ai/model-jaggedness)):
- Generation of any kind, including by chaining choices.
- Counting, arithmetic, exact numbers between Score levels.
- Date comparison, duration, ordering; extract the parts, compare in code.
- Numeric or low-level representations where a semantic label exists (hex for colours,
  assembly for source).
- Multi-hop indirection and double negations; instructions that disagree with criteria.
- Large state full of irrelevant detail.
- Adversarial text in `state`: it "can move the answer", because state is data, not trusted
  input.
- Anything where the answer must be read out of a file, database or tool Jev cannot see.
- Authorisation and destructive actions as a sole decider: the thresholds pick workflows,
  code confirms them
  ([probability routing](https://docs.typesafe.ai/patterns/probability-routing)).
- Options the model can lean on by position: it favours the first option, so reorder and
  re-ask before trusting a close call
  ([jaggedness](https://docs.typesafe.ai/model-jaggedness)).

## Measure before trusting

Run the vendor's repeatability protocol on your own inputs: repeat each borderline case
15 times, count how often the decision would change across every cutoff, and score each
input by its least stable question
([noul cookbook](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook)). Repeat it
when the rubric wording or the model changes. Calibrate the threshold against labelled
cases, plotting confidence against accuracy
([how to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)), and store
each answer beside the question text and the threshold it was compared against, because the
`instructions` and `criteria` are what the model actually answers
([literal reading](https://docs.typesafe.ai/model-jaggedness#literal-reading)).
