---
name: autopilot
description: >
  Arm, check, or switch off autopilot in THIS project — automatic answers to stops that the
  human's own recorded words already settle, and the drift guard in front of every automatic
  continuation. `/autopilot` arms it, `/autopilot off` disables it, `/autopilot status` reports
  what is measured. The human can also type `autopilot off` / `autopilot on` in any prompt.
---

# autopilot — keep an unattended thread on its human-set course, and unblocked

Autopilot sits on top of the auto-clear cycle (`/auto-clear`). It adds two things, and both
rest on one record — the **intent ledger**: what the HUMAN said to this work thread (typed,
dictated, picked in a dialog), captured at the source, keyed by the handoff ID so it survives
every clear.

```
drift guard   after an automatic clear, the continue prompt is sent only if the fresh session
              reloaded ITS OWN thread, the silence budget is not spent, and (with a judge) the
              handoff's next step is still aligned with the human's words
auto-answer   a question dialog, a prose question, a "done, what next?" stop, or a wait on
              background work is answered ONLY when a verbatim quote of the human's own
              recorded words in this thread backs the answer
```

Why a ledger and not the transcript: the transcript records the watcher's typed prompts and
hook-supplied answers as if the human had typed or picked them. A mechanism reading "what the
human said" from the transcript would soon cite its own output as the human's direction.

## Arguments

- *(none)* or `on` — full state check, then arm what is missing.
- `off [project|session <id8>]` — switch off (default: ask which scope).
- `status` — report measured state only; change nothing.

## 1. STATE first — measure, never assume

```bash
test -f .claude/hooks/autopilot/ledger.mjs && echo installed || echo not-installed
grep -c "hooks/autopilot/" .claude/settings.json          # wired hooks (expect 4)
ls .set/handoff/.no-autopilot* 2>/dev/null                # switches: present = OFF
pgrep -af "watch-auto-clear.sh" | grep -- "--autopilot"   # watcher runs the drift guard?
tail -5 .set/handoff/autopilot.log 2>/dev/null            # recent verdicts, answered or not
```

Read `.claude/handoff.profile.md`: an `## Autopilot` section with a ```json block is the
project's tuning (judge command, budgets, deny-list additions). Without it the defaults apply —
SAY so. Autopilot without an armed auto-clear still answers stops, but nothing continues
automatically after a clear; report which of the two is the case.

## 2. ARM

1. Install package-owned files: `npx github:tatargabor/set-claude-handoff init --autopilot`
   (add `--auto-clear` if that is not installed yet). Re-running it IS the upgrade.
2. **Merges init never does** (consumer-owned; init prints the snippet, you verify with grep):
   `.claude/settings.json` gets four hook entries — `UserPromptSubmit` → `capture-prompt.mjs`,
   `PostToolUse(AskUserQuestion)` → `capture-answer.mjs`, `PreToolUse(AskUserQuestion)` →
   `answer-dialog.mjs`, `Stop` with `"asyncRewake": true` → `answer-stop.mjs`. Merge with the
   project's existing hooks; never overwrite them.
3. **Profile**: propose an `## Autopilot` section (the fields init printed). Never write it
   without the user's yes.
4. **Watcher**: restart the auto-clear watcher with `--autopilot` so every automatic
   continuation goes through `drift-guard.mjs`.
5. **Selftest** after a Claude Code upgrade: `bash templates/selftest-autopilot.sh` — it pins
   the platform behaviors autopilot relies on (dialog answers via hook input, Stop payload,
   background rewake). A failure means re-read the investigation before trusting the hooks.
6. **VERIFY** — armed without evidence is not armed: `node .claude/hooks/autopilot/ledger.mjs show
   --dir .set/handoff --session <id>` shows the thread, its entries and the silence counts;
   `node .claude/hooks/autopilot/drift-guard.mjs --session <id>` prints each check.

## 3. OFF and ON — any time after arming

**From the prompt (preferred — instant, needs no agent):** a line that starts with
`autopilot off` / `autopilot ki` (or `on` / `be`), optionally followed by `project`. The capture
hook flips the switch file before the agent's turn starts and tells the session. A prompt the
watcher typed can never flip it.

**By file** (what `/autopilot off` does):
- session: `node .claude/hooks/autopilot/ledger.mjs switch --off --dir .set/handoff --session <id>`
- project: the same with `--project` (creates `.set/handoff/.no-autopilot`)

Delete the file (or `--on`) to switch back on. The auto-clear switches are separate: autopilot
off does not stop clears, and `.no-autoclear` does not stop answers.

## 4. What stays true however you arm it

- Nothing project-specific in this skill — tuning lives in the profile.
- Never answered: a genuinely new decision, a handoff §3 user-decision item, a deny-listed action
  (push, deploy, delete, send to a client, publish, pay), an unbound session, a spent budget.
- Every answer says it is automatic and quotes the human words it relied on.
- Every stop the hooks see is logged to `.set/handoff/autopilot.log` — answered, not answered,
  or discarded — with the reason. If something was answered wrongly, the log line names the quote.
