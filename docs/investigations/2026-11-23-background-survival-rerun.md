# Measured: background work survives `/clear` (Claude Code 2.1.330, this machine) — re-run

**Date:** 2026-11-23 · **Re-runs:** [2026-09-12-background-survival.md](2026-09-12-background-survival.md)
(2.1.269, bash tasks only) · **Model in the probe sessions:** claude-haiku-5-5 (the probe needs a real
turn, not a capable one).

## Method

Two throwaway interactive `claude` sessions in tmux, cwd a scratch git dir, the agent-bus store
isolated with `SET_AGENT_COMM_DIR=<scratch>/store` (nothing reached the real bus). In each, one model
turn started the work, the turn ended, `/clear` was typed via `tmux send-keys`, and the work was then
observed from outside (`ps`, marker files, the fresh session's transcript).

| probe | what ran in the background | how it was released |
|---|---|---|
| A1 | Bash tool, `run_in_background=true`: `node <set-agent-comm>/bin/sac.mjs wait --once probe-room; echo … > sac-marker` | a broadcast QUESTION into `probe-room` of the isolated store, 2 min after the clear |
| A2 | Bash tool, `run_in_background=true` (same turn as A1): `sleep 150 && echo bg-survived > sleep-marker` | the sleep ending |
| B | Agent tool, `run_in_background=true`, a general-purpose subagent running `until [ -f GO ]; do sleep 2; done; echo … > agent-marker` in its own foreground Bash | `touch GO`, 50 s after the clear |

## Result: all three SURVIVED, and their notifications reached the fresh session

| probe | `/clear` at (UTC) | session id before → after | process after the clear | completion | notification |
|---|---|---|---|---|---|
| A1 `sac wait --once` | 16:41:59 | `50552680` → `a45e1bf8` | alive at +68 s (past two of its own 30 s "die with the session" checks — the owning `claude` pid does not change on a clear) | exited 16:44:57 on the message, marker written | `<task-notification> … completed` in the **fresh** transcript, the fresh session answered it |
| A2 `sleep 150` | 16:41:59 | same | alive | 16:44:23, `bg-survived` written | same, in the fresh transcript |
| B background subagent | 16:46:08 | `acaab99a` → `535c2514` | its Bash loop alive at +26 s and +66 s; the agent panel kept listing it | `agent-survived` written 16:46:58 | `Agent "…" finished` delivered to the fresh session |

The fresh session's status line kept showing `2 shells` right after the clear (A), and the agent row (B).

## Consequence

- `backgroundWorkBlocks` defaults to **false** in the package from this measurement on (gate, watcher,
  skill text). The spec allowed relaxing the block only with a recorded survival measurement; this is
  that measurement for 2.1.330, covering bash tasks, a `sac wait --once` inbox watch and a background
  subagent. A project that wants the old fail-closed behaviour passes `--background-work-blocks true`.
- The gate never looked at processes anyway: with the block on, an unarmed session's verdict always
  read "blocked … unverified" simply because it had no handoff to declare "none" in (2026-11-23, one
  consumer tree: 80 of 141 watched sessions never armed).
- The 2026-10-21 claim in `compact-under-background` ("a clear starts a new session; the agents'
  notifications and ids are lost") is **not** reproduced on 2.1.330: the notification arrived in the
  cleared-into session. What a clear does lose is the old context's knowledge of WHY the agent was
  started — the handoff's duty to declare running background work stays.

## Not covered — honestly stated

- Monitors and workflows were not probed. A Monitor is a different tool with its own lifetime.
- One machine, one version. A platform update can change this: re-run the probe after upgrades
  (two scratch sessions, ~5 min, recipe above).
- A *restart* of the `claude` process is not a clear and was not probed here; the 2026-10-21 team
  loss is recorded in that proposal as a restart.
