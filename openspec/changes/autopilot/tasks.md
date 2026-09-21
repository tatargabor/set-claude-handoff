## 0. Precondition — the executor's presence gate (carried from the archived auto-clear change)

- [x] 0.1 Measure the human-presence signal on both writer paths: tmux `capture-pane` of the input line; whatever input state ownerd can report for a fleet-held pane. Record the result in the investigation. *(Measured 2026-09-13, investigation §9 M1: tmux `capture-pane -p -e` rule; ownerd has no input state — the raw `tail` paint is classified instead.)*
- [x] 0.2 `templates/watch-auto-clear.sh`: skip the pass (logged) when the input line is non-empty or keystrokes are recent; stop relying on Ctrl-U to clear the line.
- [x] 0.3 Regression test — guards the 10:03:50Z collision (`"…we don1t need opu/clear"`, then `"glm is jo lehet\x15Folytatás…"`): a non-empty input line yields no `/clear` and no continue prompt.

## 1. Pin the measured platform behavior (selftest)

- [x] 1.1 Ship `templates/selftest-autopilot.sh` (private tmux socket, scratch dir, cheap model): asserts `PreToolUse(AskUserQuestion)` `allow` + `updatedInput.answers` skips the dialog and the model receives the answer (probe P1b), and that `Stop` input carries `last_assistant_message`. *(Shipped; first live run started during apply.)*
- [x] 1.2 Same selftest: `asyncRewake` exit 2 wakes an idle session, and a human message typed during the hook does NOT cancel it (probe P3) — the fact the stale guard exists for.
- [x] 1.3 Measure whether `UserPromptSubmit` fires for a message queued mid-turn when it is dequeued; record the result in the investigation; decide the queued-message capture path from it (design decision 1 / risk list). *(Measured, investigation §9 M2: fires at Enter, no `source` key; task notifications fire it too.)*

## 2. Ledger and provenance (specs: intent-ledger)

- [x] 2.1 Ledger module (`templates/autopilot/ledger.mjs`): append entry, read thread, session→thread binding (`.thread-<session8>`), fold session-keyed file into thread file, derive silence-budget counts.
- [x] 2.2 Executor typed-log: `.set/handoff/typed.jsonl` written BEFORE every watcher write (`/clear`, continue prompt, owner-write) in `templates/watch-auto-clear.sh`.
- [x] 2.3 Regression test — guards: the watcher's auto-continue prompt was recorded as `origin:human`/`promptSource:typed` (measured 2026-09-13): a submitted prompt equal to a typed-log record is tagged `machine-typed`.
- [x] 2.4 Regression test — guards: the 10:04:22 fusion (`"glm is jo lehet\x15Folytatás…"`): a prompt containing a typed-log text plus other characters is tagged `mixed` and is not evidence.
- [x] 2.5 Regression test — guards: an `auto-answer` or `machine-typed` entry, or an option label marked "(Recommended)", is never accepted as evidence.

## 3. Capture hooks (specs: intent-ledger)

- [x] 3.1 `templates/autopilot/capture-prompt.mjs` (`UserPromptSubmit`): append `human-typed` / `machine-typed` / `mixed`; exits 0 always; no-op under `AUTOPILOT_JUDGE=1`.
- [x] 3.2 `templates/autopilot/capture-answer.mjs` (`PostToolUse` matcher `AskUserQuestion`): `human-picked` unless a pending `auto-answer` for the same `tool_use_id` exists.
- [x] 3.3 Dictation adapter contract: profile-declared command or file source appends `human-dictated`; document both shapes; absence announced in the verdicts.
- [x] 3.4 Queued mid-turn capture per the 1.3 result. *(No extra path needed — M2: the hook fires for a queued message at Enter.)*
- [x] 3.5 Prompt switch in the capture hook (user requirement 2026-09-13): directive match (defaults `autopilot off|ki|on|be`, `project` widens scope, profile extends) → create/remove the opt-out file, `directive` ledger entry, `additionalContext` with the new state, before the agent's turn.
- [x] 3.6 Regression tests: "autopilot ki" creates the session opt-out before the turn; "autopilot be" removes it; `project` targets the tree file; a `machine-typed` or `mixed` prompt containing the directive changes nothing and is logged as ignored.

## 4. Thread binding across a clear (specs: intent-ledger, drift-guard)

- [x] 4.1 Write-time gate side: when the arm marker is dropped, also write `.thread-<session8>` → handoff ID and fold the session-keyed ledger. *(Implemented lazily in `threadOf`: the arm marker proves the gate passed; the consumer-owned write-check hook stays untouched.)*
- [x] 4.2 Reinject side (`templates/hooks/handoff-reinject-clear.mjs`): write `.reload-<fresh8>` `{choice, id}` always; `.thread-<fresh8>` only for a marker-chosen reload. *(Plus the predecessor link of probe M3: the watcher's typed `/clear` record matched by the claude pid.)*
- [x] 4.3 Regression test — guards: the 08:46:52 reload loaded another worktree's handoff by mtime: an mtime-chosen reload binds no thread.
- [x] 4.4 Charter block in the reinject for a bound session: first human entry + most recent human entries, verbatim, ≤ 1 500 chars from the preview budget; "no human entry" notice when empty; total stays under the 10 000-char cap (test).

## 5. Drift guard (specs: drift-guard)

- [x] 5.1 `templates/autopilot/drift-guard.mjs`: checks `optout` (`.no-autopilot`, `.no-autopilot-<session8>`), `bound`, `budget`, `alignment` (judge when configured, else announced skip); JSON verdict; evaluates only.
- [x] 5.2 Watcher: call the drift guard after a successful automatic clear; log the verdict; send the continue prompt only on `continue: true`.
- [x] 5.3 Default continue prompt (profile-overridable): the handoff's current next step, later update sections supersede §5, stop at decisions the ledger does not answer — guards the measured stale §5 of `0912-ff48`.
- [x] 5.4 Regression tests: unbound session is not continued; exhausted budget blocks the continue prompt but not the clear; a human entry resets the budget; judge error counts as `unclear`.

## 6. Judge contract and validator (specs: auto-answer)

- [x] 6.1 Judge prompt + JSON schema (`class`, `answer`, `evidence[{entryId, quote}]`); default command `claude -p --model haiku --output-format json`, scratch cwd, `AUTOPILOT_JUDGE=1`, profile timeout (default 45 s).
- [x] 6.2 Validator (`templates/autopilot/validate.mjs`): not `NEW`; quotes verbatim (normalized, ≥ 12 chars) in named `human-*` entries of this thread; deny-list; bound handoff §3 items; bound; budget; opt-out. Package default deny-list documented.
- [x] 6.3 Regression tests: fabricated quote rejected; quote from another thread rejected; §3 item rejected; deny-list rejected even with a human quote; judge-reported confidence alone never passes.
- [x] 6.4 Regression test — guards judge recursion: with `AUTOPILOT_JUDGE=1` every autopilot hook exits 0 with no output and writes nothing.

## 7. Answer hooks (specs: auto-answer)

- [x] 7.1 `templates/autopilot/answer-dialog.mjs` (`PreToolUse` matcher `AskUserQuestion`): all questions pass → `allow` + `updatedInput.answers` with labeled values and pending `auto-answer` record; any fails → no output (dialog shows).
- [x] 7.2 `templates/autopilot/answer-stop.mjs` (`Stop`, `asyncRewake: true`): `stop_hook_active` guard, prefilter, judge, validator, stale guard (transcript last entry id, session record, ledger unchanged) → labeled answer + exit 2, else exit 0.
- [x] 7.3 Regression test — guards probe P3 (rewake delivered after the human typed): any new transcript entry or ledger entry since the stop discards the answer and logs the discard.
- [x] 7.4 Regression test — guards probe P1b (hook answer indistinguishable from a pick): the dialog answer carries the autopilot label and the ledger records `auto-answer`, never `human-picked`.
- [x] 7.5 Verdict log `.set/handoff/autopilot.log`: one line per stop seen — class, validator outcome, delivered / discarded / not answered, judge latency.
- [x] 7.6 `PARALLEL` class in the stop hook: `background_tasks` non-empty + evidence rule + a judge-cited verbatim independence sentence from `last_assistant_message`; else exit 0 and leave the wake to the completion notification.
- [x] 7.7 Regression tests — guards the 2026-09-13 screenshot case (`b955a632`, 2 shells + 1 monitor running, "ideas 2 and 6" offered): independent step with human evidence is continued; a step that needs the running result is not answered; an accepted client prompt suggestion is never evidence.

## 8. Switch, skill, wiring

- [x] 8.1 `skills/autopilot/SKILL.md`: `/autopilot` (state check → arm), `/autopilot off [project|session <id8>]`, `/autopilot status` (measured only); nothing project-specific; checks that auto-clear is armed and says so if not.
- [x] 8.2 `init --autopilot` (opt-in): installs package-owned hooks, scripts and the skill; prints the `settings.json` merges and the profile `## Autopilot` fields; never writes the profile.
- [x] 8.3 README: an "Autopilot" section — what it answers, what it never answers, the label, the switches, the log.
- [x] 8.4 `node --test` green; `openspec validate autopilot --strict` passes.

## 9. Consumer pilot (validation — executes in the consumer repo)

- [ ] 9.1 Merge the capture, answer and reinject hooks into the consumer's `settings.json` (consumer-owned: merge, never overwrite); declare the profile `## Autopilot` section with the user's yes.
- [ ] 9.2 Wire the dictation adapter (set-copilot) and verify one dictated sentence lands as `human-dictated`.
- [ ] 9.3 Arm directly (user decision 2026-09-13): selftest first, then watcher restart with the drift guard; verify one `autopilot.log` line per hook type.
- [ ] 9.4 After the first night: review `autopilot.log` — answered / not answered / discarded counts, every delivered answer checked against its quote, judge latency; write the result into `docs/investigations/` as promotion evidence.
