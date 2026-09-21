---
name: auto-clear
description: >
  Arm, check, or switch off the automatic clear + handoff reload + auto-continue cycle in
  THIS project. `/auto-clear` arms it, `/auto-clear off` disables it (project or session
  scope), `/auto-clear status` reports what is measured, not what is assumed.
---

# auto-clear — arm, check, or switch off the automatic clear cycle

The cycle this arms, once running, needs no human keystrokes:

```
1. limit (default 500k)   the gate measures each session's OWN context number
2. handoff készítés       the session writes a handoff; the write-check hook arms it
3. auto-clear             the executor types /clear when every gate holds
4. auto-reload            the SessionStart:clear hook injects the right handoff
5. auto-continue          the executor re-prompts the fresh session (optional, recommended)
```

Never clear without step 2: a session with no fresh handoff of its own is never cleared —
that is the one rule the machinery will not bend.

## Arguments

- *(none)* or `on` — full state check, then arm what is missing.
- `off [project|session <id8>]` — create a kill-switch file (below). Default: ask which scope.
- `status` — report measured state only; change nothing.

## 1. STATE first — measure, never assume

Run and report; each answer changes what you do next:

```bash
test -f .claude/hooks/clear-gate.mjs && echo gate-installed || echo gate-missing
grep -c "clear-gate\|handoff-reinject" .claude/settings.json   # hook wiring (0 = not wired)
ls .set/handoff/.no-autoclear 2>/dev/null                      # PROJECT switch: present = OFF
pgrep -af "watch-auto-clear.sh" | grep "$(pwd -P)" || true     # is a watcher armed for THIS tree
```

Also read `.claude/handoff.profile.md` — an `## Auto-clear` section there (threshold,
background-work policy, auto-continue prompt, persistence) is the project's tuning; without
it you use the defaults and SAY so.

## 2. ARM (argument `on`, or nothing when not armed)

1. Install package-owned files (safe on re-run — that IS the upgrade):
   `npx github:tatargabor/set-claude-handoff init --auto-clear`
   If the published package is older than your fixes, install from your local checkout instead.
2. **Two merges init never does** (consumer-owned; init prints them, you verify):
   - `.claude/settings.json`: SessionStart `clear|compact` matcher → `handoff-reinject-clear.mjs`,
     PostToolUse on handoff writes → the write-check arming hook (this project may already
     have its own — merge, never overwrite).
   - the statusline fragment (`templates/statusline-persist.sh`) — per-session token file.
   Verify each with a grep, and SAY which are wired and which are still manual.
   - PostToolUse `Write|Edit|MultiEdit|Bash` → `.claude/hooks/handoff-arm.mjs` — the ARMING hook,
     unless the project already has its own. Without one, no session is ever cleared (the gate
     logs `marker: no marker for this session` for ever).
   - **keep-going (optional, ask the user):** Stop → `keep-going.mjs stop --threshold <T> --max 40`
     and PostToolUse `*` → `keep-going.mjs post --threshold <T>` (exact JSON: `init` prints it). The
     session then stops only on a line starting `NEED INPUT:` or `ALL DONE:`, and writes its own
     handoff at the limit. Off: `touch .set/handoff/.no-keepgoing` (or `.no-keepgoing-<session8>`).
     Its decisions are in `.set/handoff/keep-going.log`.
3. **Watcher**: if none is running for this tree, start one under tmux (or the fleet owner):
   ```bash
   tmux new-session -d -s auto-clear-watcher \
     "bash $PWD/.claude/hooks/watch-auto-clear.sh --dir $PWD \
      --started-after $(date -u +%Y-%m-%dT%H:%M:%SZ) --interval 60 \
      --background-work-blocks <from profile, default true> \
      --auto-continue '<from profile, or: default>'"
   ```
   `--started-after now` matters: only sessions started after the reload wiring exists may
   ever be cleared. For reboot survival, install a `systemd --user` unit running the same
   command with `Restart=on-failure` and say you did.
4. **VERIFY** — an armed state without evidence is not armed:
   `tail -1 .set/handoff/auto-clear.log` must show `watcher started … auto-continue=…`;
   run the gate once by hand (`node .claude/hooks/clear-gate.mjs --session <any live id> …
   --json`) and show the 5-gate verdict. Report: threshold, which writer paths exist
   (tmux / fleet owner), auto-continue on/off, both switch states.

### macOS

Works on macOS since `d7f40c4` (no `/proc`, no GNU `date`). Needs `node`, `jq` and `tmux`, and
**Claude must run inside tmux** — on a Mac the tmux pane is the only way the watcher can type.
There is no systemd: keep the watcher in its own tmux session (as above), or use a launchd agent
for reboot survival. First run: add `--dry-run` and read the log — `dry … ELIGIBLE — would /clear
pane …` proves the session records and the pane lookup work on that machine.

## 3. OFF (argument `off`)

Kill switches are FILES, not promises — an agent's verbal "don't clear me" binds nothing:

- **project scope** (default for `off`): `mkdir -p .set/handoff && touch .set/handoff/.no-autoclear`
  — every session in this tree becomes ineligible, effective on the watcher's next pass (≤60s).
- **session scope**: `touch .set/handoff/.no-autoclear-<session8>` (`session8` = first 8
  alphanumeric chars of the session id, shown in the statusline). For YOUR OWN session, take
  the id from the statusline or the newest `~/.claude/sessions/<pid>.json`.

Re-enable by deleting the file. `status` always reports which switches exist.

## 4. What stays true however you arm it

- Nothing project-specific belongs in this skill: per-project tuning lives in
  `.claude/handoff.profile.md` (`## Auto-clear` section) — propose a section, never write it
  without the user's yes.
- The gate only ever EVALUATES; the executor types. Keep that split when you wire anything new.
- Every verdict is logged to `.set/handoff/auto-clear.log` — pass or fail. If a session is
  not being cleared, the reason is in the log, not in anyone's memory.
