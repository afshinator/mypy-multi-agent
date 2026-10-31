# Peer-to-peer prompts are deferred, not planned

A peer cannot open a prompt to another peer, and the work to make it possible is
not planned. The wire format defines a `PROMPT` frame and the runtime has an
inbound handler for it, but only the supervisor sends one
(`src/runtime/peer-messaging.ts:71`) and no peer tool writes one
(`src/peer/peer-config.ts:88-93` sends only read, grep, ls, find, web_fetch, edit,
write, bash). An inbound `PROMPT` reaches `onPrompt`
(`src/runtime/peer-messaging.ts:117`), which wakes the supervisor's await for the
named target and never re-emits the frame, so a peer-emitted prompt would not
arrive as a turn.

The trigger to revisit: a task where a peer must ask another peer something the
supervisor cannot relay. No such task is named today, and
`docs/landscape-and-positioning.md` states the next investment is not more
orchestration.

## Considered Options

- **Enable it.** Rejected: it needs a peer-side sender and a real relay, plus four
  decisions the wire does not answer — who may address whom, what a peer does while
  the target is mid-turn, how to stop A→B→A, and whether peer spend the supervisor
  never dispatched is allowed — and it contradicts the documented contract in
  `docs/agent-config-guide.md` §1 ("it has no tool to message another peer… never
  write a peer `system_prompt` that tells it to contact a sibling"). No named task
  needs it, so this is a contract change bought with nothing.
- **Delete the arm.** Rejected for now: `PROMPT` is live as the supervisor→peer
  prompt frame, so the frame type cannot be deleted; what would remain is removing
  `onPrompt` and enforcing supervisor-only senders. That is a code change with no
  user-visible benefit while the reachability is documented instead. It stays
  available if the deferral wording ever proves insufficient.
- **Defer and stop calling it designed.** Chosen. The capability is described everywhere
  as not implemented and not planned, rather than as "designed but not reachable",
  which read as a capability waiting on a bug fix.

## Consequences

The words "designed but not reachable" are gone from `README.md`,
`docs/temp-handoffs/01-architecture-handoff.md`, `docs/landscape-and-positioning.md` and
`docs/trace-semantics-oracle.md`; each now says not implemented and not planned and
cites this record. The supervisor's `send_prompt` tool and the guide's §1 contract
are unchanged and remain accurate.

Reopening this requires naming the task that needs peer-to-peer prompts, and then
answering the four questions above as a follow-up ADR — not by restoring a sentence
in a diagram.
