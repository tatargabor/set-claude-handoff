## Context

The auto-clear cycle is armed on the consumer (change `auto-clear-with-handoff-reload`): the gate, the
watcher (tmux send-keys and fleet owner-write), the arm marker `.written-<session8>`, and the
`SessionStart(clear|compact)` reinject that prefers the session's own marker over mtime. Everything this
change relies on about the platform was measured on 2.1.270 by live probe
([investigation §5](../../../docs/investigations/2026-09-13-thread-anchor-and-auto-answer.md)):

- `PreToolUse` fires on `AskUserQuestion` with `tool_input.questions`; `allow` + `updatedInput.answers`
  (keyed by exact question text) skips the dialog, and the model cannot tell the answer from a pick.
- `Stop` input carries `last_assistant_message`, `stop_hook_active`, `background_tasks`, `transcript_path`.
- `asyncRewake: true` + exit 2 wakes an idle session with the hook output as a `task-notification` turn —
  and is NOT cancelled by a human message typed meanwhile.
- `UserPromptSubmit` carries `prompt` and `source`; a tmux/owner-typed prompt is still `user`.
- The transcript records watcher-typed prompts as `origin.kind:"human"`, `promptSource:"typed"`.
- `/goal` is a session-scoped Stop hook and does not survive `/clear`.
- Session record: `status:"waiting"`, `waitingFor:"input needed"` while a dialog is open.

## Goals / Non-Goals

**Goals:** the ledger with provenance, thread binding across clears, the drift guard in front of the
existing continue step, the two answer hooks with a deterministic evidence validator, kill switches, init
wiring, and a consumer pilot armed directly with post-hoc log review.

**Non-Goals:** no keystroke-delivered answers; no `/goal` re-arming (P4 — possible later from the ledger);
no change to the gate, marker or reload requirements of the auto-clear capability (its change was archived
as `c46661f` while this one was drafted, so the measured presence-gate typing bug — which the user placed
in that change — is carried here as the task 0 precondition, touching only the executor); no `skills/handoff/SKILL.md` change in v1; no escalation mechanism of our own —
an unanswered stop stays where it is, and a project's existing route (the consumer's Discord bridge) is
the project's business.

## Decisions

1. **Capture at the source, never from the transcript.** Hooks append ledger entries as the input
   happens: `UserPromptSubmit` (typed), `PostToolUse(AskUserQuestion)` (picked), a profile-declared
   dictation adapter (dictated). *Rejected:* a transcript reader — measured to see watcher prompts and
   bridges as human (investigation §4), so it would feed automatic output back in as human direction.
2. **Executors log before they type.** The watcher appends `{at, session, kind, sha256, text}` to
   `.set/handoff/typed.jsonl` before every write. Capture compares the submitted prompt with the recent
   records of that session after stripping control bytes: equal → `machine-typed`; contains → `mixed`
   (the measured 10:04:22 fusion). *Rejected:* recognizing machine prompts by their wording or a leading
   `\x15` — true of today's prompt only, and the profile can change the prompt.
3. **One file per thread, keyed by handoff ID.** `.set/handoff/ledger/<ID>.jsonl`; before a handoff exists,
   `ledger/s-<session8>.jsonl`. The write-time gate that drops the arm marker also writes
   `.thread-<session8>` → ID and folds the session-keyed file into the thread file. The reinject writes
   `.thread-<fresh8>` → ID **only** for a marker-chosen reload, and writes `.reload-<fresh8>` with
   `{choice: marker|mtime|none, id}` either way, so an unbound session is a recorded fact, not an absence.
   *Rejected:* keying by session — dies at every clear, which is the whole problem.
4. **The silence budget is derived, not stored.** Count `machine-typed` continue prompts and `auto-answer`
   entries after the last `human-*` entry in the thread's ledger. No counter file to drift or to reset
   wrongly; the ledger is the single source. Defaults: 3 automatic continuations, 8 automatic answers
   (profile).
5. **The drift guard is a script the watcher calls, same shape as the gate.** `drift-guard.mjs --session
   <fresh>` → `{continue, checks:[{name, ok, detail}]}`; it only evaluates, the watcher types. Checks:
   `optout` (`.no-autopilot`, `.no-autopilot-<session8>`), `bound`, `budget`, `alignment` (judge, when
   configured). The watcher logs the verdict and sends the continue prompt only on `continue: true`. The
   default continue prompt (profile-overridable) targets the handoff's current next step, with later update
   sections superseding the next-steps list, and stops at decisions the ledger does not answer.
6. **The charter block lives in the reinject.** For a bound session, the reinject adds "Thread direction —
   the human's own words" with the thread's first human entry and the most recent human entries, capped at
   1 500 characters, taken from the handoff preview budget so the total stays under the 10 000-character
   cap.
7. **The judge proposes, a deterministic validator decides.** Judge output schema:
   `{class: DERIVABLE|APPROVAL|NEW, answer, evidence:[{entryId, quote}]}`. The validator requires: class not
   `NEW`; at least one evidence item; each quote (whitespace- and case-normalized, ≥ 12 characters) a
   substring of the named entry; the entry `human-*` and in this thread; no deny-list match on question or
   answer; the question not matching the bound handoff's §3 items; the session bound; the budget not
   exhausted; no opt-out. *Rejected:* trusting a judge confidence score — the measured failure is plausible
   derivation, which a confidence number does not catch and a quote check does.
8. **Dialogs via `PreToolUse`, prose stops via `Stop` + `asyncRewake`.** `PreToolUse(AskUserQuestion)`:
   judge every question; only when all pass, return `allow` + `updatedInput.answers`, each value
   `<answer> — [autopilot: from your HH:MM message: "<quote>"]`; otherwise print nothing and the dialog shows
   (P1b made partial answers impossible to present honestly). The hook records a pending `auto-answer` keyed
   by `tool_use_id`, which the `PostToolUse` capture consults so the auto pick is never logged as
   `human-picked`. `Stop`: cheap prefilter on `last_assistant_message` (question mark, choice phrase, or a
   completion with an open next step in the handoff) before any judge call; `stop_hook_active` exits 0;
   after judging, the **stale guard** re-reads the transcript's last entry id and the session record and the
   ledger — anything new since the stop → exit 0 and log a discard (P3 trap); else print the labeled answer
   and exit 2.
9. **The judge runs outside the hooks' reach.** Default judge command: `claude -p --model haiku
   --output-format json` with `AUTOPILOT_JUDGE=1` in its environment, run from a scratch working directory;
   every autopilot hook exits 0 immediately when `AUTOPILOT_JUDGE=1`. Timeout from profile (default 45 s);
   timeout or error → no answer, logged. *Alternative:* `type: "prompt"` hooks — rejected, their evaluator
   sees only the hook input, not the ledger.
10. **Armed directly, reviewed post hoc (user decision 2026-09-13).** Every stop the hooks see is logged
    to `.set/handoff/autopilot.log` with class, validator outcome and delivery, answered or not; a later
    human answer to an unanswered stop is also captured, so precision can be scored from the log after the
    pilot night — the same evidence a shadow run would have produced.
11. **Package vs profile.** Package: ledger module, capture/answer/drift hooks, validator, `/autopilot`
    skill, init wiring, tests. Profile `## Autopilot` section: judge command and timeout, deny-list (the
    package documents a default list), budgets, continue prompt, dictation adapter. `init` documents the
    fields and never writes them.
12. **The prompt switch lives in the capture hook, not in the agent.** `UserPromptSubmit` already sees
    every submitted prompt with its provenance (decision 2), so it matches the directive, creates or
    removes `.no-autopilot-<session8>` (or `.no-autopilot` with `project`), appends a `directive` ledger
    entry, and returns `additionalContext` stating the new state — all before the agent's turn. Only
    `human-typed` prompts can toggle. *Rejected:* letting the agent run `/autopilot off` on request — the
    auto-clear skill already recorded why ("an agent's verbal promise binds nothing; the file does"), and an
    agent in a drifted state is exactly the one that should not own the switch.
13. **Background wait is its own stop class, gated twice.** The `Stop` input's `background_tasks`
    (measured present) marks the class `PARALLEL`. Besides the evidence rule, the validator requires a
    verbatim sentence from `last_assistant_message` — cited by the judge — in which the agent states the step
    is independent of the running result; without it the hook exits 0 and the harness's completion
    notification wakes the session as today. Client prompt suggestions (`promptSource:
    suggestion_accepted`, the grey ghost text) are agent-authored and are never evidence. Example that
    motivated it (user screenshot, 2026-09-13): `b955a632` waiting with 2 shells + 1 monitor running,
    offering "ideas 2 (alias table) and 6 (disagreement flag)" before arm HX finishes.

## Risks / Trade-offs

- [A plausible but wrong answer looks like the human's decision] → verbatim-quote validator, never-answer
  classes, label in the answer text, `auto-answer` provenance, silence budget; the user armed directly, so
  the first-night log review is the first real precision measurement.
- [Judge latency blocks a dialog the human is watching] → 45 s timeout; timeout shows the dialog as
  today; latency is logged per call and reviewed in the pilot.
- [Fused or reworded machine text escapes the typed-log match] → `contains` match tags `mixed`, which is
  never evidence; worst case is a missed human entry, not a false one.
- [Stale rewake despite the guard (race inside the check window)] → the guard is the last step before exit;
  the residual window is milliseconds against a 20–45 s judge; the human's newer message is in the
  transcript before the stale answer, and the answer is labeled.
- [Hook recursion through the judge session] → `AUTOPILOT_JUDGE=1` guard plus scratch cwd, with a
  regression test.
- [Stop hook runs on every turn end, cost] → deterministic prefilter before any judge call; the stop-block
  cap (8) is never approached because each answer consumes budget.
- [Queued mid-turn human messages may bypass `UserPromptSubmit`] → measured first (task 1.3); if bypassed,
  the capture also reads the `queued_command` attachment at the next hook run.

## Migration Plan

1. Pin the probed platform behaviors in a selftest (so an upgrade that breaks them fails loudly).
2. Land ledger, provenance log, capture hooks, binding — useful alone: the charter block and the
   unbound-session stop work without any judge.
3. Land the drift guard in the watcher; then the validator, judge contract and answer hooks.
4. Consumer pilot: merge hooks, declare the profile section, arm, review the log after the first night.
   Rollback: `.no-autopilot` in the tree disables answers and continuations at once; removing the hook
   entries returns to today's auto-clear behavior.

## Implementation notes (apply, 2026-09-13 — what the second probe round changed)

Measured facts behind each note are in the investigation §9.

- **Binding is lazy, not written by the write-time gate** (decision 3). The write-check hook is
  consumer-owned; instead `threadOf` treats the session's own `.written-<session8>` as the proof the
  handoff passed the gate and binds (and folds) on first use — no hook-ordering race, same spec
  behavior.
- **The predecessor of a clear is linked by the executor, not the platform** (probe M3: no pointer in
  the payload, the transcript, or the already-rewritten runtime record). The watcher logs
  `{kind: clear, session8, pid}` before typing `/clear`; the reinject walks its process ancestry to the
  `claude` pid and matches it. The reinject therefore now also CHOOSES the handoff by the predecessor's
  marker after an automatic clear — before, a fresh id could never match a marker, so every automatic
  clear fell back to mtime (the 08:46:52Z near-drift). A manual clear still binds nothing, announced.
- **Presence on the fleet path reads ownerd's raw tail** (probe M1: ownerd has no input state). The
  last `❯\xa0` paint up to `\r` follows the same rule as the tmux capture; incremental keystroke echo
  is not yet measured on that path.
- **No Ctrl-U / ESC before typed commands.** The measured fusion carried the Ctrl-U byte literally;
  with the presence gate guaranteeing an empty line, the executor types text, then Enter, separately.
- **Capture skips task notifications** (probe M2: they fire `UserPromptSubmit` with their XML as the
  prompt and no `source` key — autopilot's own rewake answer arrives in that shape). Queued mid-turn
  messages need no extra path: the hook fires at Enter.
- **File layout.** All autopilot modules live in `templates/autopilot/` and install flat into
  `.claude/hooks/autopilot/`, so their `./x.mjs` imports resolve in both trees; the reinject loads the
  ledger optionally and behaves as before without it. `init --auto-clear` now ships the watcher and
  `presence.mjs` too — the watcher refuses to start without its presence check.

## Open Questions

- Which dictation adapter is provable from a file in the consumer: set-copilot's handover command or a
  `PostToolUse` on the `/dd` call. Either satisfies the spec; the pilot picks one.
- Judge cost per stop on a real ledger — measured in the pilot, may tune the prefilter.
