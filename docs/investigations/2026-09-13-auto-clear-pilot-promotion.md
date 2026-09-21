# auto-clear pilot — promotion evidence (task 6.6)

Date: 2026-09-13 · Consumer: the consumer repo (dev, Claude Code 2.1.270) · Watcher: `.claude/hooks/watch-auto-clear.sh`
Log: `<consumer-repo>/.set/handoff/auto-clear.log` · Every number below has its command next to it.

## The verdict: promoted

The armed cycle — *limit → handoff készítés → auto-clear → auto-reload → auto-continue* — ran
end-to-end four times on 2026-09-13 with no human keystrokes in the loop, across both writer
planes (tmux-held and fleet ownerd-held panes) and both tree shapes (main repo and worktree).

## The starved night (why arming alone proved nothing)

```bash
awk '{print $2}' auto-clear.log | sort | uniq -c        # 1423 no / 317 skip / 0 clears
grep -c "statusline-stale" auto-clear.log               # 1061
grep -c "no tmux pane hosts pid" auto-clear.log         # 65
wc -l auto-clear.log                                    # 1742 (19:02Z→08:24Z)
```

1742 verdicts overnight, zero clears. Two structural blockers starved it: the token gate
short-circuited on a stale-but-valid statusline file instead of using the transcript fallback
(1061×), and 65 eligible skips had no writer path (ownerd-held panes, tmux-only executor).
Both fixed in `01b429b` (gate + watcher) — the session that motivated the fix sat at 528k
with its own handoff armed and "Ready for /clear" in the transcript.

## The four live fires

```bash
grep -E "FIRE|CONTINUE" auto-clear.log | tail -8
```

| time (UTC) | session | tree | writer | reload | continue |
|---|---|---|---|---|---|
| 08:46:52 | bugfix `9adce541` (528k) | main | owner-write | reinject ran (wrong page — cross-tree merge bug, reverted same hour, bridged) | n/a (bridge `/handoff 0912-a16a`) |
| 09:25:13 | consumer-worktree `9e94a4ee` | worktree | owner-write | reinject carried `0912-ff48` (own tree) automatically | n/a (monitor woke it) |
| 09:41:13 | bugfix `7ffc9ebc` | main | owner-write | reinject carried `0912-a16a` | prompt delivered, Enter swallowed (measured, fixed: `b292532`) |
| 10:03:50 | consumer-worktree `4aa5b19b` | worktree | owner-write | reinject carried `0912-ff48` | **`CONTINUE confirmed (try 1)`** — machine-verified |

## What the live fires taught (each fixed the same day, each with a regression test)

1. Stale statusline file must not block the transcript fallback (9.4 — 1061 verdicts).
2. Fleet-held agents need a roster-matched owner-write branch (9.2 — 65 skips).
3. Reinject must resolve cwd tree + worktrees, prefer the session's own arm marker, and keep
   the mtime fallback inside the session's own tree (9.1 — an all-trees merge was itself
   caught live and reverted; write-side twin: arm next to the written file).
4. Token files are per-session (9.3 — two sessions overwrote one shared file).
5. The auto-continue Enter must be a separate keypress with transcript verification (the
   swallowed-Enter fix — text+Enter in one write reads as a paste).

## Safe-off evidence

- `optout` gate: `.no-autoclear` (tree) and `.no-autoclear-<session8>` (session) —
  gate-enforced, tests "a PROJECT opt-out … beats all gates" / "the per-session kill switch".
- No own fresh handoff ⇒ no clear, ever (the own-marker gate; the log's `marker:` lines).
- Every verdict logged with its reason — the starved night was diagnosable from the log alone.

## Residual risks (carried, not hidden)

- Watcher survival across reboot is manual (tmux session) — systemd `--user` unit is the
  documented next step, also reachable via the `/auto-clear` skill's persistence note.
- The cosmetic `N ≥ threshold` detail string misleads when N is below threshold (ok flag correct).
- Fresh-id blind spot: after a clear the arm marker belongs to the OLD session id, so
  marker-first reload resolves via tree selection; id-preserving compacts hit the marker path.
