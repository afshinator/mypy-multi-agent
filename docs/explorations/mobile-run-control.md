# Mobile run control: can a batch be run and watched from a phone?

Research pass, 2026-11-03. Tree read at the working copy; no code was changed. Vendor and platform
facts carry a source token (`[S…]`), resolved in §10. Repo facts cite `path#symbol`. **SOLID** =
quote- or code-backed. **PROJECTED** = nobody has run it; the row carries the check that settles it.

Companion documents: [`pi-durable-cloud/pi-durable-fit.md`](pi-durable-cloud/pi-durable-fit.md) (durable
peers, the host-bound gate), [`pi-durable-cloud/cloud-agent-capabilities.md`](pi-durable-cloud/cloud-agent-capabilities.md)
§6.7 (the phone capability table this document extends down to the run level).

---

## 1. Verdict

**Observation is cheap; control is not, and "run a batch from the phone" is not achievable by
installing any existing client.** Three findings drive that, in order of how much they change the design:
- **V1** The run's entire control plane is text typed into a pi TUI pane. `/mypi-multi-agent`,
  `/stop-all`, `/stop`, `/kill-all`, `/finalize` are `pi.registerCommand` entries
  (`src/pi/extension.ts:348-412`). There is no CLI, HTTP, or socket verb for any of them. A phone can
  only drive this by typing into a terminal.
- **V2** Nothing in the repo listens on a network. The only listener is the A2A bus, a Unix-domain
  socket at a filesystem path (`src/bus/socket-server.ts:16-56`) with no host, port, or TLS surface.
  The `web/` viewer is a dev-server-only read-only SPA over finished runs (`web/README.md:41-52`).
- **V3** Every existing herdr mobile client is **pane-level**. None of the seven speaks the A2A bus,
  reads `run-details/`, or knows what a run is. On a phone a four-peer run is four terminal cards.

The cheapest real answer is **tier T1**: SSH from the phone, `hc attach` or `herdr` into the workspace,
type. No new code, all of the shortcomings. The best answer is **tier T3**: a small broker process that
owns a `pi --mode rpc` supervisor and serves a run-level object. Tier T2 (a third-party client) is a
shortcut that looks better than it is until you need the run object.

---

## 2. What a run actually is, mechanically

| Code | Fact                                                                                                                                                                                              | Cite                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| F1   | Launch creates a herdr workspace, then runs `pi; herdr pane close "$HERDR_PANE_ID"` in its root pane                                                                                              | `src/pi/launch.ts:107-152`                                                                                                          |
| F2   | The run does not start until a human types `/mypi-multi-agent <name>`; the command refuses outside a herdr pane                                                                                   | `src/pi/extension.ts:400-412`                                                                                                       |
| F3   | Peers are `bun <abs>/peer-main.ts --config <abs>/.peer-<id>.json` typed into panes via `herdr pane run`                                                                                           | `src/runtime/runtime.ts:403-496`, `src/herdr/pane-manager.ts:24-32`                                                                 |
| F4   | Peer transport is a Unix socket at `<askDir>/run-details/.a2a-agent-bus.sock`, hashed to tmp if the path exceeds 100 bytes                                                                        | `src/bus/socket-server.ts:16-23`                                                                                                    |
| F5   | Liveness is a 3 s wall clock; peers exit when their socket closes                                                                                                                                 | `src/contracts/session-schema.ts:62`, `src/peer/peer-main.ts:211-218`                                                               |
| F6   | Finalize is structural and local: attester read times from `tool-calls.jsonl`, citation freshness from `statSync().mtimeMs`, validation via `sh -c` in the supervisor process, `plan.md` required | `src/runtime/finalize-gate.ts:132-140,246-259`, `src/validation/validation-runner.ts:26-48`, `src/validation/run-contract.ts:10-19` |
| F7   | The only wall-clock bound is the batch driver's own poll; nothing inside a run stops it                                                                                                           | `mypi-batch.yaml:28-31`                                                                                                             |
| F8   | Batches are serial, halt on the first non-success, and have **no resume**; a retry is a new batch                                                                                                 | `src/batch/executor.ts:201-207,381-385`, `docs/batch-guide.md:104`                                                                  |
| F9   | Batch "finished" is a filesystem heuristic: parsed frontmatter, two identical polls, `.peer-*.json` gone                                                                                          | `src/batch/executor.ts:146-194,306-322`                                                                                             |
| F10  | There is no human approval prompt anywhere; enforcement is static tool-layer permissions                                                                                                          | `src/peer/permission-gate.ts:26-62`, `src/pi/tool-permissions.ts`                                                                   |
| F11  | Pane status is cosmetic: `report-metadata` failures are swallowed and `STOPPED` is never published as a token                                                                                     | `src/herdr/status-writer.ts:36`, `src/herdr/status-adapter.ts:52-53`                                                                |
| F12  | All readable state is multi-writer, non-atomic, torn-prone, and gitignored                                                                                                                        | `src/artifacts/final-writer.ts:37-38`, `.gitignore:5-16`                                                                            |

The consequence of F1–F4 for any remote layer: **the supervisor pane is the API**, and the pane exists
only inside a live herdr TUI server on the host that owns the checkout.

---

## 3. Correction: this project is bound to Herdr **TUI**, not herdr-core

Two unrelated runtimes share a brand. `herdr-core` (`hc`) and the Herdr app are one stack; Herdr TUI is
another, with its own PTY layer, server, socket, and protocol [S1][S2][S3].

| Code | Fact                                                                                                                                                                                           | Source   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C1   | `hc` has no panes, workspaces, tabs, or zoom. It exposes flat terminals: `terminal.list/get/read/send/keys/interrupt/attach/run/label/wait/kill`, `machine.exec`, `file.*`, `events.subscribe` | [S4][S5] |
| C2   | Panes, `pane.report_metadata`, `workspace.create`, zoom and splits belong to the **TUI** socket API (protocol 22, 128 methods)                                                                 | [S6][S7] |
| C3   | Herdr TUI contains zero `herdr-core` references and cannot share sessions or panes with the app                                                                                                | [S1][S2] |
| C4   | Herdr TUI does **not** implement OSC 7501; it infers status by scraping panes through 22 bundled manifests (`src/detect/manifests/*.toml`), which is what "22 agents detected" means           | [S8]     |

So this repo's herdr usage (`workspace create`, `pane split`, `pane report-metadata`, `pane run`) works
only against the TUI server, and the new Herdr app cannot host a run. That also retires an earlier
assumption: the per-peer status line on a pane is this repo's own `report-metadata` tokens (F11), not
OSC 7501. Clients that read OSC 7501 read something this project never emits on the TUI side.

---

## 4. Three tiers, and what each actually buys

### T1 — SSH plus the existing CLI (no new code)

Phone → SSH/Tailscale → host → `herdr` (attach the workspace) or `herdr pane read <id>` for text.
- **Buys:** everything. Observing, typing a slash command, `/finalize`, `/stop-all`. It is the only
  path that reaches the real control plane today.
- **Costs:** a terminal on a phone keyboard; no run-level view; nothing survives the host sleeping
  except by keeping it awake.
- **Verified cost:** `hc`/`herdr` sockets have **no authentication and no per-client check** — "There is
  no separate API password or per-client permission check. Other programs running as your account are
  part of the trust boundary" [S9]. The socket must never be forwarded; SSH is the whole perimeter.
- **Verdict:** SOLID, and the only tier that works this week.

### T2 — an existing herdr mobile client

Seven clients were verified against a one-row-per-tool matrix; all are pane-level.

| Tool                        | Answers a prompt                      | Starts an agent/workspace    | Drives pi panes                 | Auth                                                                       |
| --------------------------- | ------------------------------------- | ---------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `0cv/herdr-mobile-relay`    | yes                                   | yes                          | yes (Pi integration documented) | 32-byte key → P-256 ECDH + AES-256-GCM per device, controller/reader roles |
| `AltanS/collie`             | yes (lifts pi's own question screens) | yes (`+ New`)                | yes                             | pairing token for all reads                                                |
| `devswha/ovis`              | yes                                   | yes (workspace/tab/worktree) | yes                             | pairing + token + Tailscale                                                |
| `powerfooI/roamgate`        | yes                                   | yes                          | yes                             | single password, 30-day cookie, "does not check `Origin` or `Host`"        |
| `ZingerLittleBee/Heeler`    | yes                                   | yes                          | yes                             | QR-pinned SSH keys, iOS only                                               |
| `eliasstravik/shepherdr`    | yes                                   | own coordinator only         | **no** ("not pi, for now")      | none documented                                                            |
| `dcolinmorgan/herdr-remote` | scraped                               | no                           | transcripts only                | token optional, off-loopback only                                          |
- **Buys:** a real phone UI, push notifications, and a terminal, without you writing one.
- **Does not buy:** the run. No client sees `conversation.jsonl`, `final.md`, DoD verdicts, cost, or
  "needs you"; a batch is invisible until you open the right pane.
- **Fails on:** F1–F2 unchanged — starting a run means typing `/mypi-multi-agent` into the supervisor
  pane, which is exactly what T1 does with more steps.
- **Verdict:** PROJECTED. Worth one afternoon on `0cv` (closest match: Pi slash commands plus
  start/stop) but it does not close the gap, and it adds a remote-code path to a socket with no auth
  behind it.

### T3 — a broker you own (the only run-level design)

Shape: one process on the host that (a) starts and owns the supervisor as `pi --mode rpc --session
<file>`, (b) reads `run-details/` for the run object, (c) serves one authenticated endpoint.

| Code | Fact                                                                                                                                                                               | Source |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1   | pi's modes are closed to `interactive`, `print`, `json`, `rpc`; there is no server mode and no ACP                                                                                 | [S10]  |
| P2   | `--mode rpc` is "a long-lived subprocess controlled through JSON records on stdin and stdout", exposing prompt, steer, follow-up, abort, `get_state`, `get_entries`, fork, compact | [S11]  |
| P3   | The pipe is readable only by the parent, so observation **requires owning the process**; no attach endpoint exists                                                                 | [S10]  |
| P4   | Sessions persist as unlocked JSONL with no run-state field; `PI_SESSION_FILE` is published and documented for tailing                                                              | [S12]  |
| P5   | No shipped transport, pairing, TLS, or push. The only first-party listener is a loopback OAuth callback                                                                            | [S10]  |
| P6   | `pi-durable` ships durable tasks, `resume()`, `watch()` and hibernation but **no wire layer**: "await send(ops); // for example to a remote client that applies them"              | [S13]  |
- **Buys:** a real run object — task list, per-peer state, DoD verdicts, cost, `final.md` — plus verbs
  that are not keystrokes, and a status that survives the phone sleeping.
- **Costs:** a new component (~a few hundred lines), the supervisor no longer being an interactive TUI
  a human types into, and a decision about where the approval gate lives.
- **Verdict:** SOLID as a shape, PROJECTED in detail. The shortest useful slice is read-only: broker
  parses `run-details/{run-state.json,conversation.jsonl,final.md}` and serves them over Tailscale
  Serve. That is `web/` with a live poller and an auth story, and it does not touch the run at all.

---

## 5. Where pi-durable fits, and where it does not

It does not solve mobile access. It solves _crash and sleep_. The two are orthogonal, and combining
them means building T3 and then choosing a durability engine underneath it.
- **It fits** if the requirement is "a run survives the host rebooting mid-run". Today a kill is a lost
  run: resume restores the transcript and agent config only, never in-flight requests, bash children, or
  extension memory [S12].
- **It does not fit** as a remote access layer: no listener, no client protocol, and "One process owns a
  storage at a time; there is no cross-process locking" [S13] — so the phone must never touch storage,
  which is precisely the broker's job.
- **Cost of adopting it:** a second recovery contract beside `run-state.json`, plus the host-bound
  finalize gate of F6 stays exactly where it is (see `pi-durable-fit.md` §6.5). It also is not installed
  here; `@earendil-works/pi-server` (sockets + CBOR, "peer authentication remains application policy and
  is not implemented") is experimental and not wired to the coding agent [S10].

---

## 6. What breaks first

Ordered by how quietly each one fails.

| Code | Failure                                                                                                                                                            | Why it bites a remote operator                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| R1   | The host sleeps. Lid close is a sleep trigger, and no `caffeinate` flag stops it; `-s` is also AC-only [S14][S16].                                                 | The phone shows a dead endpoint with no explanation                                |
| R2   | F5's 3 s heartbeat. A suspended host wakes with every peer past deadline and mass-marks them `AGENT_CRASHED`, and each peer already exited on socket close.        | The run looks catastrophic on wake, and it is — peers are gone                     |
| R3   | F10: there is no approval prompt. "Approve from phone" has nothing to approve unless an approval gate is added.                                                    | The whole mental model of remote unblocking does not apply yet                     |
| R4   | F9's finished-detection is a heuristic any remote UI must reimplement or inherit as a lie                                                                          | A phone that says "done" while a peer is still writing is worse than no phone view |
| R5   | F8: no batch resume. A halt at ticket 3 of 7 costs the whole batch.                                                                                                | The single most valuable phone verb — "continue" — does not exist                  |
| R6   | T2 tools put a web-facing surface in front of a socket with no authentication [S9]                                                                                 | The blast radius is a shell as your user on the machine holding every checkout     |
| R7   | F12: torn JSONL mid-write. A reader can parse a half-written line                                                                                                  | Status flickers or throws exactly when you are watching                            |
| R8   | A bare SSH/TCP session dies on phone sleep or Wi-Fi↔LTE handoff: iOS suspends the app and "UIKit can disconnect a background or suspended scene at any time" [S19] | The channel is lost exactly when the run needs an answer                           |
| R9   | Tailscale key expiry defaults to 180 days; when it lapses, "connections to/from the given endpoint will stop working" [S17]                                        | Remote access dies silently months after it was set up                             |

### 6.1 The host layer, verified

The host must be awake and the channel must outlive the phone; neither is a property of this repo.

| Code | Fact                                                                                                                                                                                                                                                                                                              | Source     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| N1   | Lid close sleeps a Mac laptop: "On a Mac laptop, close the display" is listed as a way to put it to sleep. No userspace process runs through it. `hibernatemode 3` keeps memory, so processes _resume_ on wake — but the sleep tears down the network, so a socket-based peer wakes already disconnected (cf. R2) | [S16][S14] |
| N2   | `caffeinate` offers idle, display, disk and AC-only system assertions. Neither it nor `pmset` documents a lid-close override; the supported path is closed-display mode, which requires an external display, mouse and keyboard                                                                                   | [S14][S16] |
| N3   | "Wake for network access" (`womp`) wakes the machine _briefly_ and is off on battery by default                                                                                                                                                                                                                   | [S14][S16] |
| N4   | `ttyskeepawake` prevents idle sleep while a remote tty session is active — the one documented lever that a persistent SSH/terminal session holds, and it is idle sleep only                                                                                                                                       | [S14]      |
| N5   | Tailscale needs no paid plan for phone→laptop: Serve proxies a loopback listener (`only http://127.0.0.1 is supported for proxies`), MagicDNS and ACLs are on all plans. **Funnel** publishes to the entire internet and is the wrong tool here                                                                   | [S17]      |
| N6   | Cloudflare Tunnel's named tunnels need a domain on your Cloudflare account; quick tunnels are for testing and die with the process. ngrok's free tier is public by design (interstitial page, not auth)                                                                                                           | [S18]      |
| N7   | Web Push on iOS needs 16.4+, Add-to-Home-Screen, and **no Apple Developer Program membership**; only a self-built APNs app costs $99/year. Self-hosted ntfy still needs ntfy.sh for APNs and its own FAQ calls the iOS app "bare bones and quite frankly a little buggy"                                          | [S20]      |
| N8   | A durable channel is mosh over tmux, not a held SSH socket: mosh "allows roaming, supports intermittent connectivity", and SSH loses the connection on roaming                                                                                                                                                    | [S19]      |

---

## 7. Minimum system worth building

Sequenced so each step is useful alone and nothing is wasted if you stop.

| Step | What                                                                                                                                                                                                                                                                                            | Settles                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M1   | Keep the host genuinely awake and reach it privately: lid open or closed-display mode (N1–N2), `caffeinate -i` held for the run's lifetime, Tailscale **Serve** with key expiry disabled per device (N5, R9), and mosh+tmux for the interactive channel (N8). Not Funnel, not ngrok, not `womp` | R1, R8, R9 — verify with a real 30-minute cellular test and one lid-close to confirm the sleep behaviour you actually get |
| M2   | Read-only broker: parse `run-details/` + `mypi-tasks/000-batches/*/summary.json`, poll every 2 s, serve over Tailscale Serve behind device auth                                                                                                                                                 | T3's first slice; makes a batch legible on a phone                                                                        |
| M3   | Push on state edges only: peer `AGENT_STALLED`/`AGENT_CRASHED`, `FINALIZED`, batch halt. Not per-turn                                                                                                                                                                                           | Noise is what kills these systems                                                                                         |
| M4   | Add the **approval gate** F10 lacks, with one shape: a pending decision written to `run-details/pending-decision.json`, answered by the broker                                                                                                                                                  | R3; also makes `/finalize true                                                                                            | false` remotely expressible without keystrokes |
| M5   | Own the supervisor: `pi --mode rpc --session <file>` under the broker, so verbs are records, not keystrokes                                                                                                                                                                                     | P3 — this is the step that turns T1 into T3                                                                               |
| M6   | Only if R5 hurts: batch resume from the record (`run.json` + `summary.json` already carry everything needed)                                                                                                                                                                                    | Turns "retry is a new batch" into "continue"                                                                              |

Do not build: a terminal emulator, an OSC 7501 reader (F11, C4: this project publishes metadata, not
OSC 7501), or anything that forwards the herdr socket off-host [S9].

---

## 8. Questions that decide the design

Each one changes an answer above; none is answerable from the repo.

| Code | Question                                                                                                                         | What it decides                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Q1   | Which device, and is a browser acceptable or must it be a native app?                                                            | T2 shortlist (iOS-only Heeler vs PWA), and whether push is Web Push or APNs                             |
| Q2   | Is the laptop allowed to be the always-on host, or must a run continue while it is shut?                                         | T1 vs a VM host. F6 makes the gate host-bound: the host that judges must be the host that ran the peers |
| Q3   | Do you need to **start** a batch from the phone, or only observe, stop, and finalize?                                            | Whether M5 is required at all. Observe-only stops at M2                                                 |
| Q4   | Is pane-watching acceptable on a phone, or is a run-level object the point?                                                      | T2 vs T3                                                                                                |
| Q5   | Is there a human decision you actually want to delegate remotely — and if so, which one, when there is no approval prompt today? | M4, the only place a phone answer is genuinely worth money                                              |
| Q6   | What is the auth story you would accept: Tailscale ACL + SSH key only, or a public endpoint with device pairing?                 | T2 tool choice and whether any third-party relay is admissible at all                                   |
| Q7   | Would you give up the interactive supervisor TUI (typing slash commands into a pane) for a record-driven supervisor?             | M5. This is the real cost of T3 and the reason T1 stays viable                                          |
| Q8   | Is halt-and-new-batch fine, or is resuming a halted batch at ticket _n_ required?                                                | M6                                                                                                      |
| Q9   | Does this stay single-user, single-host, or is it aimed at the VM shape `pi-durable-cloud` already researched?                   | Whether M1–M2 should be built host-agnostic                                                             |

---

## 9. Unverified

| Code | Claim                                                                                              | What closes it                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| X1   | A third-party client can start `mypi-run` in a fresh workspace and the run then behaves normally   | One real run launched from `0cv` or `ovis`; watch F2's pane refusal                     |
| X2   | Tailscale Serve reaches a laptop's loopback with the lid open and survives network changes         | One 30-minute cellular test                                                             |
| X3   | `pi --mode rpc` can host the supervisor's tool surface unchanged (custom extension tools included) | Load `src/pi/extension.ts` under rpc mode and run one work order                        |
| X4   | A read-only broker reading `run-details/` mid-run produces a coherent view                         | Two runs sampled at 1 Hz, counting parse failures (R7)                                  |
| X5   | An approval gate can be answered by a broker without breaking the finalize gate (F6)               | One run where a phone-answered decision lands in `final.md`                             |
| X6   | A broker behind Tailscale Serve with key expiry disabled survives a month of real use              | A calendar reminder at day 179 plus one client reconnect after a tailnet key rotation   |
| X7   | Closed-display mode holds a run overnight without a thermal or power problem                       | One overnight run with a peer in flight, then compare `run-state.json` before and after |

---

## 10. Sources

Primary sources fetched 2026-11-03 by the research pass; each claim above resolves to one of these.
- **[S1]** <https://raw.githubusercontent.com/herdrdev/herdr-core/master/README.md> — `herdr-core` / `hc` is a flat-terminal runtime; the app is one client of it.
- **[S2]** <https://raw.githubusercontent.com/herdrdev/herdr-app/master/README.md> and `src/hc.rs` — "The window arranges terminals. The core runs them."
- **[S3]** <https://github.com/herdrdev/herdr> (Herdr TUI) — own PTY stack, own server, socket at `~/.config/herdr/herdr.sock` (0600), no `herdr-core` references.
- **[S4]** <https://raw.githubusercontent.com/herdrdev/herdr-core/master/docs/commands.md> — `terminal.*`, `machine.*`, `file.*`, `doc.*`, `events.subscribe`, `rpc.discover`; no pane/workspace verbs.
- **[S5]** <https://raw.githubusercontent.com/herdrdev/herdr-core/master/schema/README.md> — JSON-RPC 2.0 over a Unix socket; `hello {framed:true}` framing.
- **[S6]** <https://herdr.dev/docs/socket-api/> — TUI socket API, protocol 22, 128 methods including `pane.report_metadata`.
- **[S7]** <https://herdr.dev/docs/cli-reference/> — `herdr pane split|read|zoom|report-metadata`, `herdr workspace create`.
- **[S8]** Herdr TUI `src/detect/manifests/*.toml` (22 files) and herdr.dev agent docs — pane status is screen-scraped; OSC 7501 absent from the TUI source. Spec itself is upstream in Ghostty: <https://raw.githubusercontent.com/ghostty-org/ghostty/main/src/terminal/osc/parsers/program_status.zig>.
- **[S9]** <https://raw.githubusercontent.com/herdrdev/herdr-core/master/docs/security.md> — "There is no separate API password or per-client permission check… Do not expose the socket or forward the raw API to people you would not trust with a shell on that machine." Also `docs/machines.md` for the SSH-carried transport.
- **[S10]** Installed `@earendil-works/pi-coding-agent` 1.4.0: `dist/main.js:79-90` (mode set), `dist/modes/index.d.ts:4-8`, `package.json:9-10`, `dist/extensions/mcp/oauth.js:347-352` (loopback callback only).
- **[S11]** `docs/rpc.md:3` (installed pi) — long-lived subprocess over JSONL; `docs/rpc-commands.md:155-184` for `get_state`.
- **[S12]** `docs/session-format.md:11-14,64-199`, `docs/environment-variables.md:27,44-45` (installed pi) — JSONL tree, no run/checkpoint entry, `PI_SESSION_FILE` tail example.
- **[S13]** <https://raw.githubusercontent.com/earendil-works/pi/v1.4.0/packages/durable/README.md> — durable tasks, `onWake`, `resume()`, `watch()`, `ConversationTranscript`; "One process owns a storage at a time"; the `send(ops)` remote comment is illustrative, not a protocol.
- **[S14]** `man caffeinate` (Darwin) — `-i` prevents idle sleep; `-s` "valid only when system is running on AC power". `man pmset` — `sleep`, `womp` (wake for network access), `lidwake`, `ttyskeepawake` ("prevent idle system sleep when any tty (e.g. remote login session) is 'active'").
- **[S16]** Apple, _Put your Mac to sleep or wake it_ (support.apple.com/guide/mac-help/mh10330) — "On a Mac laptop, close the display"; and _Use your Mac laptop with the lid closed_ (support.apple.com/en-us/102282) — "First you need to allow an external display, a mouse, and a keyboard to connect". Also _Set sleep and wake settings_ (mchle41a6ccd) — wake for network access is a brief wake to reach shared services.
- **[S17]** Tailscale KB: _Tailscale Serve_ (kb/1242, kb/1312) — serve is tailnet-only, Funnel is "open to the entire internet", and "only http://127.0.0.1 is supported for proxies"; _Key expiry_ (kb/1028) — 180-day default, "connections to/from the given endpoint will stop working"; _MagicDNS_ (kb/1081) and _ACLs_ (kb/1018) — available on all plans; _Pricing_ — "$0 Free forever".
- **[S18]** Cloudflare Tunnel docs — "Add a website to Cloudflare. Change your domain nameservers" for named tunnels; quick tunnels "create a temporary trycloudflare.com URL" and are "for testing and development". ngrok docs — free tier: "Up to 3 online endpoints", "Interstitial page on HTTP/S endpoints", "1 team member".
- **[S19]** mosh docs — "allows roaming, supports intermittent connectivity", "Most network programs lose their connections after roaming, including SSH"; UDP 60000–61000. Apple, _Managing your app's life cycle_ — a suspended scene can be disconnected at any time. Blink Shell ships mosh with connection survival across device sleep.
- **[S20]** webkit.org/blog/13878 — Web Push on iOS/iPadOS 16.4+, "You do not need to be a member of the Apple Developer Program to use it", Home Screen web app required. ntfy docs/FAQ — self-hosting still forwards to ntfy.sh for APNs, "The iOS is very bare bones and quite frankly a little buggy". Apple Developer Program — "99 USD per membership year".
- **[S15]** Mobile clients, each repo's README/docs at its current head: `0cv/herdr-mobile-relay`, `AltanS/collie`, `devswha/ovis`, `powerfooI/roamgate`, `ZingerLittleBee/Heeler`, `eliasstravik/shepherdr`, `dcolinmorgan/herdr-remote`. Auth and capability rows are quoted from those files; version and issue counts as of the fetch.
