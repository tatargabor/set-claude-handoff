## 1. Measure

- [x] 1.1 Cause of compactions below the size threshold: idle, ~54.7 min before the cache expiry (measured 2026-11-23 by the fleet session; method and numbers in design.md Context) [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [x] 1.2 Look up whether the runtime's idle compaction has its own setting or documented timing; record the answer and its source [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [x] 1.3 Measure the p95 of tokens one turn adds (main-thread transcripts, 7 days) — the margin for a later relative size threshold; record only, no behaviour change in this change [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [x] 1.4 Probe whether a `PreCompact` hook fires on an AUTOMATIC compaction (size and idle) on the current runtime; record the result — a backstop is a separate change only if it fires [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]

## 2. Gate

- [x] 2.1 `clear-gate.mjs`: an `idle` verdict — age of the last assistant record, `--idle-minutes` (default 48), `--idle-floor` (default 200000), the 54-minute stop; JSON carries `idle.due`, `idle.minutes`, `idle.reason` [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [x] 2.2 Tests: due at 48 min / 250k; not due below the floor; not due when the turn is running; late at 55 min without a marker [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]

## 3. Watcher

- [x] 3.1 `watch-auto-clear.sh`: when `idle.due` and unarmed → the nudge path (same record); when armed → the clear path with every existing gate and the fire lock; log lines name `warm-idle` [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [x] 3.2 Flags `--idle-minutes` / `--idle-floor` (0 disables), shown in the startup line [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [x] 3.3 Watcher-level tests with fake HOME and fake tmux, each failing without the change [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]

## 4. Close

- [ ] 4.1 `npm test`; the selftests on their private socket only [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]
- [ ] 4.2 Skill text and spec updated; the rollout (template upgrade + watcher restarts) waits for the owner's OK [REQ: an-idle-session-is-rotated-while-its-cache-is-warm]

## Acceptance Criteria (from spec scenarios)

- [ ] AC-1: WHEN a 250k session is idle 48 min, unarmed, never nudged THEN `/handoff` is typed once and recorded, log names warm-idle [REQ: an-idle-session-is-rotated-while-its-cache-is-warm, scenario: idle-large-unarmed]
- [ ] AC-2: WHEN a 250k session idle 49 min holds a passing marker THEN `/clear` and the continue prompt are typed as on the size path [REQ: an-idle-session-is-rotated-while-its-cache-is-warm, scenario: idle-large-armed]
- [ ] AC-3: WHEN a 150k session is idle 50 min THEN nothing is typed, verdict names the floor [REQ: an-idle-session-is-rotated-while-its-cache-is-warm, scenario: below-the-floor]
- [ ] AC-4: WHEN a session idle 55 min has no armed handoff THEN no `/clear`, log says the warm window was missed [REQ: an-idle-session-is-rotated-while-its-cache-is-warm, scenario: too-late-to-hand-off]
- [ ] AC-5: WHEN the turn is not idle THEN the warm-idle trigger is not due [REQ: an-idle-session-is-rotated-while-its-cache-is-warm, scenario: a-working-turn-is-never-interrupted-for-idle]
