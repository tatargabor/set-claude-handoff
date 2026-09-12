## Context

The building blocks exist and are measured (see `docs/investigations/2026-09-12-auto-clear-and-reload.md`
for the full inventory): consumer-repo runs the soft-limit measurement (context-guard, 500 000 tokens),
the PreCompact machine page, the post-compact content reinject (proven path: SessionStart
`additionalContext`; the PreCompact `customInstructions` path measured dead), and the write-time handoff
gate — which already receives `session_id`. The platform (2.1.269) documents `SessionStart source: clear`,
the 10 000-char hook-output cap, and `context_window.total_input_tokens` in the statusline JSON; it also
documents that hooks cannot run slash commands or open a tty, and that on this machine a foreign terminal
cannot be typed into (`legacy_tiocsti=0`). The installed skill is ahead of this repo — measured 2026-09-12.

## Goals / Non-Goals

- **Goals**: the last mile, package-side — the marker convention, the gate contract, the reload-after-any-
  clear hook template, init wiring (opt-in), and the pilot plan that arms it in one consumer.
- **Non-Goals**: not replacing the compact path; not shipping a keystroke executor in the package; not
  changing `SKILL.md` beyond the one-line Phase 4 amendment and the sync-back; not blocking auto-compact
  in v1; not building the fleet/Remote-Control integration (contract only).

## Decisions

1. **Per-session marker over a transcript regex.** The write-time gate already sees `session_id` and the
   file path; a marker it drops is deterministic and testable, while a regex re-derives the same fact from
   an officially unstable format and cannot distinguish threads. *Alternative rejected*: grepping the
   transcript for the skill's "Ready for /clear" line — prose, spoofable by form, and format-unstable.
2. **Statusline persistence as the token source, transcript as fallback.** `total_input_tokens` is the
   documented live number; the statusline script already receives it on every render, so persisting it to
   a runtime file costs one line. Reads older than a bound (no render = no fresh number) are treated as
   "unknown", and unknown is not above-threshold. *Alternative rejected*: parsing transcript `usage` fields
   as the primary — it works today (context-guard proves it) but is documented as breakable on any release.
3. **The package ships the contract; the environment ships the keystrokes.** The gate is a testable script
   + template; the trigger is implemented per environment. Corrected 2026-09-12 evening (user challenge,
   verified in set-core source): fleet agents are launched as **`claude -p`** (`chat.py` stream-json,
   `subprocess_utils.py` one-shot) — **`/clear` typed into them is meaningless** (no TUI parses slash
   commands; in stream-json mode raw text is not a valid frame). So there are two context-management
   planes, and they must not be conflated: **(a) interactive TUI sessions** — the pty master is tmux, the
   executor is `tmux send-keys` (measured end-to-end on 2.1.269: typed text renders, `/clear` + Enter
   swaps to a fresh session, process alive); **(b) fleet `-p` agents** — no keystrokes apply; context is
   managed by the **manager rotating the process** (close at the threshold, start fresh, carry the
   handoff) — the manager already receives per-agent token counts (`context_fill.py`), so it holds both
   levers in-protocol, and this is the same shape as the 2026-09-01 "no long-lived controller context"
   decision. The earlier "fleet owner types /clear" idea is dropped as a category error. Probe gotchas
   worth keeping: a `claude` whose stdout is not the pane tty drops to print mode and exits (the executor
   must never wrap the session's stdio), and a first-launch trust dialog swallows keystrokes exactly like
   a permission prompt — both confirm the "no pending prompt" gate. *Alternatives considered*: set-copilot
   sidecar as the watcher host (viable, deferred); systemd user unit (viable, more moving parts).
4. **One reinject hook, both matchers (`clear` and `compact`), pointer + preview, idempotency per
   event.** Generalizing the proven compact reinject avoids a second implementation of the same safety
   rules. Measured defect in the current hook being fixed here: its once-per-**session** marker suppresses
   reinjection on later compacts of the same session — reinject markers are visible in only 4 of 17
   measured compacts, and the one session that compacted 4× in a day could only reinject once by design.
   Idempotency therefore keys on the event occurrence, not the session lifetime. The v1 payload shape
   also changes: pointer + preview within the documented 10 000-char cap, full file read from disk. The
   old 16 000-char injection exceeded the cap and got the platform's documented overflow behavior (file
   path + short preview) — the same shape we now produce deliberately, so the preview content and the
   truncation notice are ours, not the platform's side effect.
5. **Thresholds live in the profile; the package defaults them.** 500 000 tokens (decided 2026-08-26 in
   consumer-repo, measured: a 480k firing once left ~7k of slack; a handoff costs ~5–10k to write). The
   measured auto-compact trigger actually sits at ~666k (17 events, clustered 566k–672k) — so the real
   reaction window from a 500k soft limit is ~166k tokens, wider than the configured-gap estimate; the
   gate has room to wait for idle. `init` never writes a profile — it documents the fields (two-owners
   boundary).
6. **Failure ordering is fixed and tested.** Watcher dead → compact fires → machine page → compact
   reinject. PreCompact *blocking* is out of v1: it is only safe against the proactive compact, and it
   removes the backstop precisely when the clear path has already failed.
7. **Background work blocks until measured.** Survival across `/clear` is undocumented; the pilot measures
   it on 2.1.269 before the profile may relax the gate (a recorded measurement, not an assumption).
8. **Sync-back is task 0.** Editing a repo-side skill that is behind what consumers run would make the
   next `init` a downgrade; the drift is measured, not hypothetical.

## Risks / Trade-offs

- [mtime heuristic loads another thread's handoff] → already mitigated in the reinject: announce the
  heuristic, name the other files; the trigger side is per-session so the *arming* is never wrong.
- [statusline did not render recently → stale token number] → freshness bound on the persisted file;
  stale/unknown = not eligible (fail toward no-clear).
- ["Idle" races an async Stop hook (e.g. a 900 s verification still writing)] → idle is defined by the
  transcript tail (turn ended, no pending tool result) plus the no-pending-permission gate; the dry-run
  pilot logs near-miss timings before arming.
- [Platform cap/behavior drift (10k cap, `source: clear`, statusline fields)] → each is asserted by a
  regression test pinned to the measured build; a failing assertion is loud, not silent.
- [Automation clears a session the user wanted to keep] → the marker proves a fresh handoff exists and the
  pre-clear conversation is saved and resumable; dry-run night precedes arming.

## Migration Plan

1. Sync the installed skill back into the repo (no behavior change on consumers).
2. Land package pieces: marker convention, gate script + templates, clear-reinject hook template, init
   wiring (opt-in), tests.
3. Pilot in consumer-repo: marker in the write-check hook, reinject extended to `clear`, statusline
   persistence, dry-run watcher for at least one unattended night.
4. Measure (gate outcomes, reload behavior, background-work survival), then arm; only then promote the
   one-line skill amendment consumer-facing.
   Rollback: remove the watcher from the executor; hooks degrade to no-ops (absence is announced).

## Open Questions

- Can a headless Remote-Control client be authenticated for programmatic `/clear`? (Probe; if yes, the
  trigger becomes fully documented end-to-end.)
- Do harness-tracked background tasks survive `/clear` on 2.1.269? (Pilot measures; decides whether the
  gate's background-work condition relaxes.)
