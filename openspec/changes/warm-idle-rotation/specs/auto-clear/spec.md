## ADDED Requirements

### Requirement: An idle session is rotated while its cache is warm
WHEN a watched session is between turns, its last assistant record is at least `--idle-minutes`
(default 48) old, its context holds at least `--idle-floor` tokens (default 200000), and it is not
opted out, the executor SHALL rotate it before the runtime's idle compaction: if the session is
unarmed it SHALL type `/handoff` (recording it exactly as the arm nudge does, so it is never asked
twice), and once the session is armed by a handoff that passes the content gate it SHALL type
`/clear` under the same presence, turn and fire-lock gates as the size path. A session whose idle
time has passed 54 minutes without an armed handoff SHALL NOT be cleared, and the skip SHALL be
logged with the reason.

#### Scenario: Idle, large, unarmed
- **WHEN** a session at 250k tokens has been idle for 48 minutes with no arm marker and no nudge record
- **THEN** `/handoff` is typed once, the record is written, and the log names the warm-idle trigger

#### Scenario: Idle, large, armed
- **WHEN** a session at 250k tokens, idle 49 minutes, holds a passing handoff marker
- **THEN** `/clear` is typed and the auto-continue prompt follows, exactly as on the size path

#### Scenario: Below the floor
- **WHEN** a session at 150k tokens has been idle for 50 minutes
- **THEN** nothing is typed and the verdict names the floor

#### Scenario: Too late to hand off
- **WHEN** a session idle 55 minutes has still no armed handoff
- **THEN** no `/clear` is typed and the log says the warm window was missed

#### Scenario: A working turn is never interrupted for idle
- **WHEN** the session's turn state is not idle
- **THEN** the warm-idle trigger is not evaluated as due
