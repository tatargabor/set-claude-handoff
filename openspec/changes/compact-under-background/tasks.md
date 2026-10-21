# Tasks: compact-under-background

- [x] 1.1 Gate: `action` (clear | compact | null), `--compact-on-background`, `--compact-threshold` (default 350 000). Verify: tests — background-only refusal with marker, idle, ≥ threshold → `compact`; below threshold, no marker, or not idle → null; flag off → null; all gates hold → `clear`. [REQ: Compact instead of clear while background work runs]
- [x] 1.2 Watcher: `/compact` for action `compact` through the same checks; marker removed after the fire; compact-continue prompt after the turn is idle. Verify: `bash -n`; a dry-run pass logs „would /compact”. [REQ: Compact instead of clear while background work runs]
- [x] 1.3 Skill text (auto-clear) and the consumer redeploy. Verify: the consumer's watcher restarted with the flag logs `compact-on-background=on`. [REQ: Compact instead of clear while background work runs]

**Done 2026-10-21:** gate tests 21/21 (`node --test test/clear-gate.test.mjs`, five new); `bash -n` ok; a live gate run on
a lead session with three agents read tokens 259 510 < 350 000, not idle → no action (correct); a consumer repo
redeployed, its unit restarted: `watcher started … compact-on-background=on (≥ 350000)`.
