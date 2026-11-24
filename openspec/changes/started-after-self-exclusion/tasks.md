## 1. Measure

- [x] 1.1 Confirm the resume path: a `claude --resume <id>` of an excluded session gets a new runtime record (startedAt after the filter), loads the current hooks, and reloads its handoff after a `/clear` (probe on a private tmux socket) [REQ: a-session-excluded-by-the-start-filter-is-told-once]
  — measured 2026-11-24 on Claude Code 2.1.331 (scratch project, private tmux socket, one handoff
  page carrying a probe token). The resumed process got a new runtime record: startedAt
  07:24:40.972Z, after the wiring stamp 07:24:08Z, with the same session id. Its `/clear` ran
  `SessionStart:clear` and the token was in the fresh transcript. The resume path holds.
  — CONTROL, and it contradicts D1's premise: the original process had started with NO reload
  hook in `.claude/settings.json`. The hook was added while it ran, and a `/clear` 3 s later
  already ran it and reloaded the page. On 2.1.331, a running session picks up a hook added to
  project settings, so a session that started before the wiring is not necessarily without it.
  Whether the start filter is still needed is an open decision; this probe does not settle it.

## 2. Executor

- [x] 2.1 `watch-auto-clear.sh`: write `.excluded-<session8>` (reason, resume command) on the first start-filter skip, then log that skip once per session [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [x] 2.2 Default the filter to the recorded wiring time; `init --auto-clear` records it (`.set/handoff/.reload-wired-at`) [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [x] 2.3 Watcher tests (fake HOME, fake tmux): one record, one log line, no keys; a restart after wiring watches the old session [REQ: a-session-excluded-by-the-start-filter-is-told-once]

## 3. Surfacing

- [x] 3.1 The session learns it is excluded: keep-going's post hook (or the handoff skill's Phase 1) reads `.excluded-<session8>` and says it once [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [x] 3.2 `/auto-clear` skill: after starting the watcher, state whether THIS session is excluded and give the resume command [REQ: a-session-excluded-by-the-start-filter-is-told-once]
  — the resume path itself is unmeasured (task 1.1): the skill's `claude --resume` advice carries a caveat to verify the reload before relying on it

## 4. Close

- [x] 4.1 `npm test`; tell the set-core seat which stamp its default install should read [REQ: a-session-excluded-by-the-start-filter-is-told-once]
  — set-core's `auto-clear-default-install` should READ `<tree>/.set/handoff/.reload-wired-at` (ONE ISO-8601 UTC-with-Z line, `Date.parse`-able) instead of writing its own install time; this package's `init --auto-clear` writes it once and never rewrites it.

## Acceptance Criteria (from spec scenarios)

- [x] AC-1: WHEN the arming session predates the watcher THEN one `.excluded-<session8>` with reason and resume command, and one skip line [REQ: a-session-excluded-by-the-start-filter-is-told-once, scenario: the-arming-session-predates-the-watcher]
- [x] AC-2: WHEN a watcher restarts in a tree wired earlier THEN a session started after the wiring is watched [REQ: a-session-excluded-by-the-start-filter-is-told-once, scenario: a-watcher-restart-in-a-tree-already-wired]
- [x] AC-3: WHEN an excluded session is resumed THEN it is gated and its own marker arms it [REQ: a-session-excluded-by-the-start-filter-is-told-once, scenario: a-resumed-session-is-included]
  — proven at the watcher level (a new runtime record postdating the stamp, its own earlier marker arming the clear); the live `claude --resume` probe itself stays open under 1.1.

## 5. Follow-up — the filter goes opt-in (owner decision 2026-11-24, after the task 1.1 control)

- [x] 5.1 Watcher: no start filter without `--started-after`; `--started-after wired` opts into the wiring stamp; with the filter off a stale `.excluded-<session8>` is removed and logged as `no start filter` [REQ: a-session-excluded-by-the-start-filter-is-told-once]
- [x] 5.2 Skill and tests follow: the stamp tests pass `--started-after wired`, a new test proves a stamp alone no longer filters [REQ: a-session-excluded-by-the-start-filter-is-told-once]
