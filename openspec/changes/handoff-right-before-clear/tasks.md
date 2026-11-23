## 1. Gate

- [x] 1.1 Marker gate: fresh = last assistant record (fallback transcript mtime) ≤ marker + request window; detail names the lag [REQ: a-clear-needs-the-handoff-to-be-the-last-act]
- [x] 1.2 Nudge at ratio 1.0; due for unarmed OR stale; numbered records (base, .2, .3), re-ask only after an answer; verdict names the record to create [REQ: an-unarmed-session-is-asked-once-for-its-handoff]
- [x] 1.3 Gate tests, each failing without the change [REQ: a-clear-needs-the-handoff-to-be-the-last-act]

## 2. Watcher

- [x] 2.1 `nudge_record` creates the file the verdict names (noclobber), logs n/3 [REQ: an-unarmed-session-is-asked-once-for-its-handoff]
- [x] 2.2 Watcher tests: a stale marker at the threshold types /handoff, not /clear [REQ: an-unarmed-session-is-asked-once-for-its-handoff]

## 3. Close

- [x] 3.1 Skill, README; `npm test` [REQ: an-unarmed-session-is-asked-once-for-its-handoff]

## Acceptance Criteria (from spec scenarios)

- [x] AC-1: WHEN an unarmed idle session reaches the threshold THEN /handoff once, record written [REQ: an-unarmed-session-is-asked-once-for-its-handoff, scenario: unarmed-session-approaches-the-limit]
- [x] AC-2: WHEN a stale marker at the threshold THEN no /clear, /handoff typed, record .2 [REQ: an-unarmed-session-is-asked-once-for-its-handoff, scenario: stale-handoff-at-the-limit]
- [x] AC-3: WHEN the latest record is newer than the marker THEN no nudge [REQ: an-unarmed-session-is-asked-once-for-its-handoff, scenario: already-nudged]
- [x] AC-4: WHEN three records and stale THEN no nudge, reason names the native compaction [REQ: an-unarmed-session-is-asked-once-for-its-handoff, scenario: asked-three-times]
- [x] AC-5: WHEN fresh handoff THEN eligible; WHEN 30 min work after THEN marker gate fails with lag [REQ: a-clear-needs-the-handoff-to-be-the-last-act, scenario: fresh-handoff]
