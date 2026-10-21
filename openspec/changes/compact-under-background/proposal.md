# Proposal: compact-under-background

## Why

Measured 2026-10-21 in a consumer repo: a lead session running three background subagents was never cleared — every
verdict for hours read `background: blocked … no resolvable "none" declaration` — and the harness then compacted it by
itself at ~405 k tokens, mid-turn, below the 500 k clear threshold. The background gate is right to refuse `/clear`
(a clear starts a new session; the agents' notifications and ids are lost — the same evening a restart killed the whole
team), but nothing used the one action that keeps them: `/compact` stays in the same session, and the agents survived
the harness's own compactions that day (they reported after the 17:48Z and 20:04Z compactions).

## What Changes

- The gate gains an `action` in its verdict: `clear` when every gate holds; `compact` when the only reason to refuse is
  running background work, the session's own handoff marker exists, it is idle, not opted out, and its context is at
  least the compact threshold (default 350 000). Off unless `--compact-on-background true`.
- The watcher types `/compact` for action `compact`, through the same presence, turn, fire-lock and disk checks, then
  removes the session's `.written-<session8>` marker (so the next compact needs a fresh handoff) and, with
  auto-continue, sends a compact-continue prompt naming the handoff once the turn is idle again.

## Impact

`templates/clear-gate.mjs`, `templates/watch-auto-clear.sh`, `test/clear-gate.test.mjs`, the auto-clear skill text.
