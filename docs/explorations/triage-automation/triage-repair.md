# The triage repair

When the verifier flags claim rows that do not reproduce, the author gets one bounded repair
round before the ticket is refused: correct only the flagged rows' `command` and `observed`
cells, then the verifier re-runs those rows alone. Criteria, the Definition of Done and KIND are
frozen — a DoD-criterion mismatch and every other refusal code skip this round entirely.

## The prompt

The operator pastes the flagged rows and the verifier's evidence into the placeholder.

````text
SITUATION
You wrote the triage report whose claim table is below. A verifier re-ran each row's command
and flagged these rows as not reproducing. Its evidence for each is given. Fix each flagged row
by correcting its `command` or `observed` cell — the one-line authoring defect that broke it: a
flag whose meaning is not what the row assumed, a range that stops short of the line it cites,
or a claim that outruns what its command shows. If a row cannot be corrected, return it
unchanged.

FUNCTION AND ARTIFACT
Return exactly one fenced ```json block and nothing else: one entry per flagged row, in the
order given, with exactly the keys `row`, `command`, `observed`. Correct no other row, no
criterion, no Definition of Done, no KIND.

FLAGGED ROWS
<FLAGGED ROWS>

Output exactly:
```json
[
  { "row": <n>, "command": "<corrected command>", "observed": "<corrected observed>" }
]
```
````
