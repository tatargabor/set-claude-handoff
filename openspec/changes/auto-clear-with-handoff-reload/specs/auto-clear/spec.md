## Purpose

Defines when a session may be cleared automatically: the per-session signal that a handoff was really
written, the gate conditions that must all hold before any external trigger may issue `/clear`, and the
backstop ordering that bounds every failure — so an unattended session degrades to today's compact path,
never to a wedged or emptied session.

## ADDED Requirements

### Requirement: Per-session armed marker
The handoff write-time gate SHALL record a marker unique to the writing session (session id and timestamp)
in the handoff directory when, and only when, a handoff file passes the content gate. A failed or absent
gate MUST leave no marker, so an unarmed session is distinguishable from an armed one.

#### Scenario: Handoff passes the gate
- **WHEN** a session writes a handoff file that passes the content gate
- **THEN** a marker named for that session id exists in the handoff directory with a current timestamp

#### Scenario: No handoff written
- **WHEN** a session has written no handoff, or its handoff failed the content gate
- **THEN** no marker for that session exists, and the session is not armed for an automatic clear

### Requirement: Gates must all hold before an automatic clear
An automatic `/clear` SHALL be issued only when every gate holds: the session's context size is at or above
the configured threshold; a marker for THIS session exists and postdates the session's start; the session
is idle (no tool call awaiting its result); and no permission request is pending. If any gate fails, no
clear is issued.

#### Scenario: All gates hold
- **WHEN** context ≥ threshold, this session's marker exists and is fresh, the turn has ended, and nothing
  awaits a permission decision
- **THEN** the session is eligible for an automatic clear

#### Scenario: Permission prompt pending
- **WHEN** the session shows a pending permission request
- **THEN** no automatic clear is issued, regardless of context size

#### Scenario: Context below threshold
- **WHEN** the session's context size is below the configured threshold
- **THEN** no automatic clear is issued

### Requirement: Another session's handoff must not arm this session
In a tree worked by parallel sessions, a marker written by one session MUST NOT arm the clear of another;
session identity comes from the session's own id, never from "a handoff exists" or "the newest file".

#### Scenario: Sibling thread writes a handoff
- **WHEN** session B writes a handoff while session A (no handoff of its own) exceeds the threshold
- **THEN** session A is not armed; only B's own marker could arm B

### Requirement: The clear comes from outside the cleared session
The automatic `/clear` SHALL be issued by an external executor (fleet terminal owner, tmux send-keys, or
a remote-control client) — never by the session's own tools or hooks. An environment where no external
writer exists (a bare foreign terminal) MUST yield no trigger rather than an unsafe workaround.

#### Scenario: No terminal-write path available
- **WHEN** the gate holds but the environment offers no external writer for that session
- **THEN** nothing is sent to the session; the gate outcome says so

### Requirement: The backstop stays reachable
Nothing in this capability SHALL disable, block, or indefinitely postpone the existing compaction backstop
(auto-compact, the PreCompact machine page, and post-compact reinjection). Every persistent failure of the
clear path MUST land in the current compact path.

#### Scenario: Watcher dies at night
- **WHEN** the trigger never fires and context keeps growing
- **THEN** auto-compact still fires at its configured window and the post-compact reinject still loads

### Requirement: Unverified background work blocks the clear
Where survival of harness-tracked background work across `/clear` has not been measured in the running
environment, the gate SHALL treat running background work as blocking. An environment MAY relax this only
with a recorded measurement that such work survives.

#### Scenario: Background task still running
- **WHEN** a harness-tracked background task is running and no survival measurement exists
- **THEN** no automatic clear is issued while it runs

### Requirement: The gate can run without triggering
The gate SHALL offer a dry-run mode that evaluates every gate, reports each gate's outcome, and triggers
nothing — so a pilot accumulates measured decisions before it is armed.

#### Scenario: Dry-run pilot night
- **WHEN** the watcher runs in dry-run mode overnight
- **THEN** each evaluation is logged with per-gate outcomes and no keystrokes reach any session
