## Purpose

Defines the checks between an automatic clear and an automatic continuation, so that a chain of unattended
cycles stays on the direction the human set for the thread and stops, loudly, when it cannot show that it
does.

## ADDED Requirements

### Requirement: Automatic continuation requires a bound thread
The executor SHALL send an automatic continue prompt only to a session bound to a thread. A fresh session
whose reload was chosen by file age, or whose binding is missing, MUST NOT be auto-continued; the log names
the reason.

#### Scenario: Reload loaded another worktree's handoff
- **WHEN** an automatic clear's reload picked a handoff by modification time
- **THEN** no continue prompt is sent and the log records "unbound — reload chosen by mtime"

### Requirement: The human direction travels verbatim across a clear
The reload after a clear of a bound session SHALL inject, beside the handoff preview, a bounded block of the
thread's human-sourced ledger entries quoted verbatim: the thread's first human direction and its most recent
human entries, within the platform's hook-output cap. Where the ledger has no human entry, the block SHALL
say so.

#### Scenario: Third automatic cycle of one thread
- **WHEN** a thread is cleared and reloaded for the third time
- **THEN** the fresh context receives the human's original direction in the human's own words, not only the
  agent's latest summary of it

### Requirement: The continue target is the handoff's current next step
The continue prompt SHALL direct the session to the handoff's current next step — a later update section
supersedes the original next-steps list — and SHALL instruct it to stop at any decision the thread's ledger
does not already answer.

#### Scenario: Next-steps list already partly done
- **WHEN** the handoff's next-steps list names steps that a later update section marks done
- **THEN** the continue prompt does not direct the session to redo them

### Requirement: A human-silence budget bounds every unsupervised chain
The drift guard SHALL count automatic continuations and automatic answers in a thread since its last
human-sourced ledger entry. When a configured budget is reached, no further automatic continuation or
automatic answer SHALL be given until a new human-sourced entry exists. A human entry resets the count.

#### Scenario: Budget exhausted overnight
- **WHEN** a thread has had the configured number of automatic continuations with no human input between
- **THEN** the next automatic clear still runs, but no continue prompt is sent and the log says the silence
  budget is exhausted

### Requirement: An alignment verdict, when configured, gates the continuation
Where a judge is configured, before each automatic continuation the drift guard SHALL obtain a verdict of
`aligned`, `drifted` or `unclear` comparing the handoff's summary and next step with the thread's human
direction. Only `aligned` permits the continuation; a judge error or timeout counts as `unclear`. Where no
judge is configured, the drift guard SHALL say so in its verdict and rely on the deterministic checks.

#### Scenario: Handoff's next step leaves the thread
- **WHEN** the judge returns `drifted` for a thread whose human direction is a bugfix and whose next step is
  unrelated feature work
- **THEN** no continue prompt is sent and the verdict with its reason is logged

### Requirement: Every drift-guard verdict is logged
Each evaluation SHALL be logged with its per-check outcome, pass or fail, including the checks that were
skipped and why.

#### Scenario: Continuation permitted
- **WHEN** all checks pass
- **THEN** the log line lists each check as passed before the continue prompt is sent
