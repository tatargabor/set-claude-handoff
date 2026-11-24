## ADDED Requirements

### Requirement: A session excluded by the start filter is told, once
WHEN the executor skips a session because its process started before `--started-after`, it SHALL
record that once per session in `.set/handoff/.excluded-<session8>`, with the reason and the resume
command that would include it, and it SHALL log the skip once per session rather than on every pass.
It SHALL NOT type into an excluded session. The filter SHALL be off unless it is asked for, because a
running session picks up a reload hook added mid-run (measured 2026-11-24 on 2.1.331, task 1.1).
`--started-after wired` SHALL take the tree's recorded clear-reload wiring time as its moment, when
one is recorded. With the filter off, a stale `.excluded-<session8>` record SHALL be removed.

#### Scenario: The arming session predates the watcher
- **WHEN** a session started at 21:23Z arms auto-clear and the watcher starts at 22:19Z with `--started-after wired` and a stamp of 22:00Z
- **THEN** `.excluded-<session8>` names the session, the reason and `claude --resume <id>`, and the log carries one skip line for it

#### Scenario: A watcher restart in a tree already wired
- **WHEN** the reload hook was wired at 10:00Z, a session started at 11:00Z, and the watcher restarts at 12:00Z with `--started-after wired`
- **THEN** the session is watched, not skipped

#### Scenario: A resumed session is included
- **WHEN** an excluded session is resumed, so a new runtime record for the same session id postdates the filter
- **THEN** it is gated like any other session, and its own earlier marker still arms it

#### Scenario: No filter by default
- **WHEN** a wiring stamp exists, a session started before it, and the watcher runs without `--started-after`
- **THEN** the session is watched, and a stale `.excluded-<session8>` from an earlier filtered run is removed and logged once
