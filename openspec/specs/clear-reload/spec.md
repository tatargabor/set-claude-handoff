## Purpose

Defines what a fresh context receives after any `/clear`: the `SessionStart(clear)` injection that turns
"cleared" into "cleared and loaded" — for the automation and for a human typing `/clear` alike — with the
cap, idempotency, and honesty rules that keep the injection cheap and trustworthy.

## Requirements

### Requirement: Every clear reloads the latest handoff
WHEN a session is cleared (manually or automatically), the fresh context SHALL receive the latest
handoff's pointer (file path and ID) and a preview of its content via the session-start hook, before the
first response.

#### Scenario: Automatic clear with a fresh handoff
- **WHEN** the automatic clear fires after the session's own handoff passed the gate
- **THEN** the fresh context's first turn includes the handoff's path, ID, and a readable preview

#### Scenario: Human types /clear
- **WHEN** the user issues `/clear` by hand
- **THEN** the same reload runs — the manual path must not be worse than the automated one

### Requirement: Injection respects the documented cap
The injected text SHALL stay within the platform's hook-output cap. When the handoff exceeds it, the
injection SHALL carry a pointer and preview plus a loud truncation notice naming the file, so the fresh
context reads the full file from disk rather than trusting a silent fragment.

#### Scenario: Handoff larger than the cap
- **WHEN** the latest handoff exceeds the cap
- **THEN** the injection contains pointer + preview + an explicit truncation notice with the file path,
  and no silently cut content is presented as whole

### Requirement: Inject at most once per clear
The reload SHALL inject once per clear event; later session-start events in the same fresh session
(resume, fork, another compact) MUST NOT re-inject the same handoff and re-grow the context the clear
just freed.

#### Scenario: Resume after a cleared session
- **WHEN** the fresh session is later resumed or compacted
- **THEN** the handoff injection is not repeated

### Requirement: The mtime choice is announced
When more than one handoff exists and the loaded one was chosen as the newest by modification time, the
injection SHALL say so and name the other live handoffs — in a parallel-session tree the newest file may
belong to another thread.

#### Scenario: Two threads, two handoffs
- **WHEN** the newest-by-mtime handoff is loaded while another thread's handoff also exists
- **THEN** the injection names the loaded file, states the mtime heuristic, and lists the other handoff

### Requirement: A compact without an own marker lists, never guesses
WHEN a session is compacted and has no arm marker of its own, the injection SHALL NOT load any handoff
chosen by modification time. It SHALL list the candidate handoffs (ID, slug, age) and state that the
session has no own handoff, should rely on its compact summary, and loads one with `/handoff <ID>` only
if it is its own. A compact keeps its summary; a newest-by-mtime page in a parallel-session tree is
usually another thread's. The clear path keeps the announced mtime fallback.

#### Scenario: Unarmed session compacts in a shared tree
- **WHEN** a session with no `.written-<session8>` marker is compacted while other threads' handoffs exist
- **THEN** no handoff body is injected, the candidates are listed with ID, slug and age, and the
  instruction to rely on the compact summary is stated

#### Scenario: Armed session compacts
- **WHEN** a session whose marker names its handoff is compacted
- **THEN** that handoff is reloaded as before

### Requirement: An empty reload is announced, never silent
WHEN a `/clear` happens and no loadable handoff exists, the fresh context SHALL be told that no handoff
was found — a cleared context with nothing to load is the most dangerous case and must not look like a
successful reload from the outside.

#### Scenario: Clear without any handoff
- **WHEN** a session is cleared and the handoff directory holds no loadable handoff
- **THEN** the fresh context receives a short notice that no handoff exists to load
