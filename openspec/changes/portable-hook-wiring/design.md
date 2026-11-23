## Context

The hooks are templates that `init --auto-clear` copies into `.claude/hooks/`, wired by
`$CLAUDE_PROJECT_DIR` paths. The global binary (`npm i -g`) already ships `templates/`. A plugin's
`hooks.json` cannot name a machine path, so its line has to find the binary at run time.

## Decisions

**D1 — The line finds the binary, never a path.** It reads
`H="$(command -v set-claude-handoff || echo "$HOME/.local/bin/set-claude-handoff")"; [ -x "$H" ] && "$H" hook arm --from-plugin || true`.
The PostToolUse and Stop lines fail open: a hook error must never break the work. The SessionStart line
prints a JSON `additionalContext` that names the missing binary (principle 3: absence is announced).

**D2 — `hook` spawns the template with inherited stdio.** The template's own `main` runs unchanged, and
its exit code passes through. It costs one more node start (~40 ms) per call. An in-process import would
save that, but it would need every template's entry guard rewritten, and the entry guard is exactly what
the symlink bug lived in.

**D3 — Stand-down is read from the project's settings.** With `--from-plugin`, the hook does nothing when
`$CLAUDE_PROJECT_DIR/.claude/settings.json` or `settings.local.json` names the hook's file
(`handoff-arm.mjs`, `handoff-reinject-clear.mjs`, `keep-going.mjs`). Settings are what decide whether a
copy fires, not whether the file exists: an unwired copy fires nothing, and the plugin line must run there.
A double reinject would inject twice, and a double keep-going would spend the budget twice.

**D4 — `plugin-files` merges and never overwrites.** It reads `<plugin-dir>/hooks/hooks.json`, or starts
with `{ "hooks": {} }`. It drops entries whose command contains `set-claude-handoff" hook` (its own, so a
re-run is idempotent) and appends the current ones. It leaves the description and every foreign hook alone.
A command naming one of the hook files directly is a vendored copy: it is reported, not removed.

**D5 — Watcher heartbeat.** Every pass the watcher writes `<tree>/.set/handoff/.watcher-alive`. keep-going
treats the tree as watched when the per-repo watcher file exists (unchanged), or when the heartbeat is
younger than 10 min. The heartbeat names the pid and the interval; only its mtime decides.

**D6 — `watch` is a thin exec.** `watch` execs `bash templates/watch-auto-clear.sh --gate
<pkg>/templates/clear-gate.mjs "$@"`. The watcher takes its presence, turn-state and autopilot modules from
the gate's directory: `AP_DIR` becomes `$(dirname "$GATE")/autopilot`, which is unchanged for the default
per-repo gate. An explicit `--gate` is kept.

## Risks

- A plugin user who also runs `init --auto-clear` in a tree gets the copy, and D3 makes the plugin stand
  down there. That is intended: the copy wins until it is removed.
- The heartbeat is 10 min old at most, so a watcher that stopped less than 10 min ago still counts as
  live. keep-going then asks for a handoff that nobody clears, once. That is acceptable.
