## Why

The auto-clear cycle (limit → handoff → clear → reload → continue) now runs a thread with no human at the
keyboard, and two gaps are measured on the consumer
([2026-09-13-thread-anchor-and-auto-answer.md](../../../docs/investigations/2026-09-13-thread-anchor-and-auto-answer.md)).
**Drift:** the only thing that carries a thread's direction across a clear is the agent's own rewrite of it
(the handoff) plus a generic continue prompt — and on the first armed morning one reload loaded another
worktree's thread, one fresh session gave its thread away on the bus, and one handoff's §5 was already
stale. **Avoidable stops:** 38 `AskUserQuestion` calls and 41 `?`-ended turns in 7 days, a median 308 s
wait after a question, the longest stop 9 h 43 min overnight — while the human had written *„elmentem
aludni amit tudsz csinald meg, vagy nyomozd ki"*; in a 25-pair sample, 7 answers were already stated
verbatim earlier. The user's words: the answer should come *„amennyiben az bizonyosan meg tudja a korábbi
inputokból"*. Both gaps share one root, measured: anything a machine types or answers is recorded as the
human's (`origin.kind:"human"`, `promptSource:"typed"`; a hook-supplied answer is indistinguishable from a
pick) — so a thread's human direction cannot be recovered from the transcript and must be captured at the
source.

## What Changes

- **Autopilot** — the umbrella name (user, 2026-09-13) for keeping an unattended thread on its human-set
  course and unblocked, on top of the existing auto-clear cycle.
- **Thread-scoped intent ledger** — an append-only record of what the human said to this thread (typed,
  dictated, picked in a dialog), written at capture time with provenance, keyed by the thread ID so it
  survives every clear. Machine-typed text and automatic answers are recorded and tagged, and are never
  usable as evidence.
- **Executor provenance log** — every text an executor types into a session (the watcher's `/clear` and
  continue prompt, owner-write bridges) is logged before it is typed, so capture can tell it from the
  human's.
- **Thread binding across a clear** — a fresh session is bound to the thread only when its reload was
  chosen by the session's own arm marker; an unbound session gets neither auto-continue nor auto-answers.
- **Drift guard at the cycle boundary** — continuity check, the charter (the thread's human direction)
  re-injected verbatim beside the handoff preview, the continue prompt aimed at the handoff's current next
  step, an optional alignment judge, and a **human-silence budget** that stops any unsupervised chain.
- **Auto-answer** — a `PreToolUse` hook answers `AskUserQuestion` and a `Stop` hook (`asyncRewake`)
  answers prose questions and "done, what next?" stops, **only** when a deterministic validator finds a
  verbatim human quote in this thread's ledger backing the answer; new decisions, handoff §3 decision items
  and profile deny-listed actions are never answered; every answer is labeled in its own text and logged.
  Kill switches mirror auto-clear (tree and session scope). Both derivable answers and approvals are answered
  immediately, present or away; armed directly with every verdict logged and reviewed post hoc (user
  decisions, 2026-09-13).
- **Prompt switch** — the human turns autopilot off or back on by saying so in a prompt, at any time after
  arming (user requirement, 2026-09-13); the capture hook flips the switch file before the agent's turn,
  so no agent can overrule it, and machine-typed text cannot flip it.
- **Parallel work while background tasks run** — a turn that ends waiting on the session's own background
  work may be continued with a step the human's direction covers and the agent itself declared independent
  of the running result (user example, 2026-09-13: a session waiting on an experiment while offering two
  cheap independent steps).
- **Executor presence gate (precondition)** — the measured watcher-types-over-the-human bug, placed by the
  user in the auto-clear change, which was archived (`c46661f`) while this proposal was drafted; carried
  here as task group 0.
- **Revision of a recorded decision** — consumer `2026-08-17-kerdes-mechanizmus-rendszerterv.md` §2.3
  (*„Nincs olyan ág, ahol az őr a felhasználó helyett DÖNT"*) is revised by the user's dictation of
  2026-09-13, restricted to answers the human's own earlier words already settle.

## Capabilities

### New Capabilities
- `intent-ledger`: what counts as the human's direction for a thread — capture sources, provenance tags,
  thread keying and binding across clears, and the rule that machine-authored entries are never evidence.
- `drift-guard`: the checks between a clear and an automatic continuation — continuity, charter
  re-injection, the continue target, the alignment verdict, and the human-silence budget.
- `auto-answer`: when a stop may be answered without the human — the evidence rule, the never-answer
  classes, labeling, the stale-answer guard, kill switches, and the per-stop verdict log.

### Modified Capabilities

(none — `auto-clear` and `clear-reload` live in the still-open change `auto-clear-with-handoff-reload`,
not yet in `openspec/specs/`; this change consumes their marker and reload contracts without changing
their requirements)

## Impact

- **Package (this repo)**: new `templates/hooks/` hooks (prompt capture, dialog answer, stop answer),
  a ledger/validator module shared by hooks and tests, watcher changes (provenance log, drift-guard call
  before the continue prompt), `init` wiring (opt-in, package-owned files only), `skills/auto-clear` gains
  the autopilot switches; `test/` regressions naming the measured bugs they guard. Any `skills/handoff/SKILL.md`
  change waits until all three consumer profiles are read (project rule).
- **Profile fields (project-owned, documented, never written by `init`)**: judge command/model, deny-list,
  silence budget, dictation/escalation adapters.
- **Consumer pilot (validation)**: the consumer's `settings.json` hook merges, the dictation adapter
  (set-copilot), and the existing Discord escalation route (private-copilot) as the profile's escalation channel.
- **Environment**: Claude Code 2.1.270 behaviors measured by live probe — `PreToolUse` on `AskUserQuestion`
  with `updatedInput.answers`, `Stop` payload `last_assistant_message`, `asyncRewake` wake-up, `/goal` not
  surviving `/clear`. Each gets a pinned regression or selftest.
