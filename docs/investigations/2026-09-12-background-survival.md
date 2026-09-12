# Measured: background tasks survive `/clear` (Claude Code 2.1.269, this machine)

**Date:** 2026-09-12 · **Method:** live probe — a scratch `claude` in a tmux pane was asked (real model
turn, glm-5.3-flash) to start a harness-tracked background bash task (`sleep 25 && echo bg-survived >
/tmp/bg-survival-marker`, Bash tool with `run_in_background=true`). Once the turn ended and before the
sleep had elapsed, `/clear` was issued via tmux send-keys. 30 s later the marker file was checked.

**Result: SURVIVED.** The marker file appeared — the background task kept running across the `/clear`
and ran to completion. The pane also stayed alive with a fresh session id, consistent with
`/clear` = new session, same process.

**Consequence for the change** (`auto-clear-with-handoff-reload`, spec: auto-clear / *Unverified
background work blocks the clear*): the spec allows relaxing the block **only with a recorded
measurement**. This is that measurement, for background **bash tasks**. Accordingly, the consumer-repo pilot
runs the gate with `backgroundWorkBlocks: false` (`--background-work-blocks false`). Scope caveats,
honestly stated:

- measured for **background bash tasks only** — Monitors, workflows and queued tasks were not probed;
- the handoff's own §4 duty to *declare* running background work stays in force regardless (that
  declaration informs the successor; it is no longer the gate's blocking condition for bash tasks);
- a platform update can change this behavior — re-run the probe after upgrades (the probe recipe is in
  this file; scratch dir, throwaway session, ~90 s).

Companion docs: [2026-09-12-auto-clear-and-reload.md](2026-09-12-auto-clear-and-reload.md),
[2026-09-12-consumer-repo-transcript-measurements.md](2026-09-12-consumer-repo-transcript-measurements.md).
