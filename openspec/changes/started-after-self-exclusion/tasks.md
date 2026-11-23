## 1. Measure

- [ ] 1.1 Confirm the resume path: a `claude --resume <id>` of an excluded session gets a new runtime record (startedAt after the filter), loads the current hooks, and reloads its handoff after a `/clear` (probe on a private tmux socket) [REQ: a-session-excluded-by-the-start-filter-is-told-once]

## 2. Executor

- [ ] 2.1 `watch-auto-clear.sh`: write `.excluded-<session8>` (reason, resume command) on the first start-filter skip, then log that skip once per session [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [ ] 2.2 Default the filter to the recorded wiring time; `init --auto-clear` records it (`.set/handoff/.reload-wired-at`) [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [ ] 2.3 Watcher tests (fake HOME, fake tmux): one record, one log line, no keys; a restart after wiring watches the old session [REQ: a-session-excluded-by-the-start-filter-is-told-once]

## 3. Surfacing

- [ ] 3.1 The session learns it is excluded: keep-going's post hook (or the handoff skill's Phase 1) reads `.excluded-<session8>` and says it once [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [ ] 3.2 `/auto-clear` skill: after starting the watcher, state whether THIS session is excluded and give the resume command [REQ: a-session-excluded-by-the-start-filter-is-told-once]

## 4. Close

- [ ] 4.1 `npm test`; tell the set-core seat which stamp its default install should read [REQ: a-session-excluded-by-the-start-filter-is-told-once]

## Acceptance Criteria (from spec scenarios)

- [ ] AC-1: WHEN the arming session predates the watcher THEN one `.excluded-<session8>` with reason and resume command, and one skip line [REQ: a-session-excluded-by-the-start-filter-is-told-once, scenario: the-arming-session-predates-the-watcher]
- [ ] AC-2: WHEN a watcher restarts in a tree wired earlier THEN a session started after the wiring is watched [REQ: a-session-excluded-by-the-start-filter-is-told-once, scenario: a-watcher-restart-in-a-tree-already-wired]
- [ ] AC-3: WHEN an excluded session is resumed THEN it is gated and its own marker arms it [REQ: a-session-excluded-by-the-start-filter-is-told-once, scenario: a-resumed-session-is-included]
