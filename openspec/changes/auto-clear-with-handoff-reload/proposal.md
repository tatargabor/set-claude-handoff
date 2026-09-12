## Why

The handoff makes `/clear` + a fresh session cheaper than a compact — but both the `/clear` and the reload
still depend on a human typing them, so unattended sessions (night shifts) hit the soft context limit and
get **auto-compacted** instead. Measured over 32 consumer-repo transcripts
([2026-09-12-consumer-repo-transcript-measurements.md](../../docs/investigations/2026-09-12-consumer-repo-transcript-measurements.md)):
compaction cuts 67–78% of context at a fixed ~666k trigger; **8 of 17 compacts hit sessions that had
written no handoff**; and the post-compact reinject was visible in only 4 of 17 — the per-session
idempotency marker suppresses it in multi-compact sessions. The burden lands on the human, in their own
words: *„és compact utan ugye ne felejts el betolteni handoffot"*, and the uncertainty with it:
*„…a compact mar automatikusan visszatölt… és ne mavult el a session?"* This cost is why the package
exists: 62 forced compacts in two days, 69% of the budget re-reading context. The compact path already
reloads handoff content (proven in production since 2026-09-05), consumer-repo already measures the soft limit
deterministically (500 000 tokens, decided 2026-08-26), and the measured reload cost is small — one
listing, one file read, one status banner. What is missing is the last mile: an automatic `/clear` once
the gates hold, and a guaranteed reload after **every** `/clear` — documented to be possible
(`SessionStart` source `clear`), currently wired nowhere.

## What Changes

- **Per-session "handoff collected" marker** — the write-time handoff gate drops
  `<handoff-dir>/.written-<session8>` when a handoff passes the content gate; the marker, not a transcript
  regex and not another thread's file, is what arms the clear for THIS session.
- **Context-size persistence** — the statusline, which already receives the documented
  `context_window.total_input_tokens` every render, persists it to a runtime file so hooks and the watcher
  read a documented number; transcript parsing stays as fallback only.
- **Clear gate + trigger contract** — a `/clear` may be issued from outside the session only when ALL
  gates hold: context ≥ threshold (default 500 000), the session's own marker exists and postdates the
  session start, the session is idle (no pending tool call, no pending permission prompt), and no unverified
  background-work assumption is relied on. The executor is environment-specific (fleet pty write, tmux
  send-keys, Remote Control) — the package ships the gate and the contract, not the keystrokes.
- **Reload after every `/clear`** — a `SessionStart` hook matching `clear` injects the latest handoff as
  pointer + preview (within the documented 10 000-char cap; the fresh context Reads the full file), with
  per-event idempotency (measured: a once-per-session marker suppressed reinjection in multi-compact
  sessions), loud truncation, and the "verify it is yours" warning. Runs for human-typed `/clear` too —
  the automation is safe because the reload is unconditional.
- **Backstop unchanged** — auto-compact (window set to 600k, measured to fire at ~666k) and the PreCompact
  machine page stay exactly as they are; every failure mode degrades to the current behavior, never to a
  wedged session.
- **Skill contract amendment (one line)** — Phase 4's "`/clear` is issued by the user, not by you" gains
  the documented exception: *or by the session's own automation, when the gates hold*.
- **Skill sync-back precondition** — the installed `~/.claude/skills/handoff` is ahead of this repo
  (measured 2026-09-12); it is synced back before any repo-side skill edit, or the next `init` downgrades
  every consumer.

## Capabilities

### New Capabilities
- `auto-clear`: the gating protocol for clearing a session automatically — the per-session written-marker,
  the gate conditions, the executor contract, and the backstop ordering that bounds every failure.
- `clear-reload`: what a fresh context receives after any `/clear` — the `SessionStart(clear)` injection
  contract: pointer + preview, cap behavior, idempotency, and the not-yours warning.

### Modified Capabilities

## Impact

- **Package (this repo)**: `skills/handoff/SKILL.md` (sync-back, then the one-line Phase 4 amendment);
  new `templates/hooks/` for the clear-reinject hook; `bin/cli.mjs` `init` wiring (opt-in, package-owned
  files only, profile untouched); `test/` regressions naming the bugs they guard.
- **Consumer pilot (consumer-repo, validation only)**: `scripts/hooks/handoff-write-check.mjs` (marker drop),
  `scripts/hooks/handoff-reinject.mjs` (extend to the `clear` matcher), `~/.claude/statusline.sh`
  (persist `total_input_tokens`), a dry-run watcher; no product code touched.
- **Environment assumptions**: Claude Code 2.1.269 (`SessionStart source: clear`, 10k hook-output cap,
  statusline `context_window`); a terminal-write path must exist for the trigger — **tmux for interactive
  sessions** (fleet `-p` agents are out of scope for keystrokes: `/clear` is meaningless without a TUI;
  their context is the manager's process rotation with a handoff — a bare foreign terminal is a system
  boundary, `legacy_tiocsti=0`).
- **Assumption recorded**: the change is drafted package-side; thresholds live in profiles (500k default),
  and the consumer-repo pilot is the validation phase of tasks.md, not a separate change.
