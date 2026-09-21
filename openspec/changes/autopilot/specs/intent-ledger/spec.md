## Purpose

Defines what counts as the human's direction for one work thread: a record captured at the source, with
provenance, that survives every clear — so that no mechanism ever mistakes machine-typed text or its own
earlier answers for something the human said.

## ADDED Requirements

### Requirement: Human input is captured at the source with provenance
Every input the human gives a session — a submitted prompt, a pick or free-text answer in a question dialog,
and a dictation delivered through a configured adapter — SHALL be appended to the thread's intent ledger at
capture time, each entry carrying its source (`human-typed`, `human-picked`, `human-dictated`), timestamp,
session id and verbatim text. The ledger MUST NOT be reconstructed from the transcript, because the
transcript records machine-typed text as human input.

#### Scenario: Human submits a prompt
- **WHEN** the human submits a prompt in a session bound to a thread
- **THEN** the thread's ledger gains one `human-typed` entry with the verbatim prompt text and session id

#### Scenario: Human picks an option in a question dialog
- **WHEN** the human answers an `AskUserQuestion` dialog that no hook answered
- **THEN** the ledger gains a `human-picked` entry holding the question text and the chosen answer

### Requirement: Machine-typed text is logged before it is typed and never recorded as human
Any executor that types into a session (the auto-clear watcher's `/clear` and continue prompt, an owner-write
bridge) SHALL record the exact text it is about to type, with session and time, before typing it. Capture
SHALL tag a submitted prompt matching such a record as `machine-typed`, and a submitted prompt that contains
machine-typed text fused with other text as `mixed`.

#### Scenario: Watcher's continue prompt is submitted
- **WHEN** the watcher types its auto-continue prompt and the session submits it
- **THEN** the ledger entry is tagged `machine-typed`, even though the transcript records it as human-typed

#### Scenario: Human's half-typed line fuses with a machine prompt
- **WHEN** a submitted prompt contains a logged machine text plus other characters
- **THEN** the entry is tagged `mixed` and is not usable as evidence

### Requirement: Only human-sourced entries are evidence
No mechanism SHALL cite a `machine-typed`, `mixed` or `auto-answer` entry, an agent-authored option label
(including a "(Recommended)" marker), or the agent's own handoff prose as evidence of the human's intent.

#### Scenario: A later question resembles an earlier automatic answer
- **WHEN** the only ledger text that would answer a question is an earlier `auto-answer` entry
- **THEN** that entry is not accepted as evidence and the question is not answered from it

### Requirement: The ledger is keyed by thread and survives clears
The ledger SHALL be keyed by the thread's handoff ID. Entries captured before the thread has a handoff are
keyed by session and SHALL be carried into the thread's ledger when that session's handoff passes the
write-time gate. A session started by a clear SHALL be bound to the thread only when its reload chose the
handoff by the previous session's own arm marker.

#### Scenario: Automatic clear with a marker-chosen reload
- **WHEN** a session is cleared and the reload chose the handoff by the pre-clear session's arm marker
- **THEN** the fresh session is bound to the same thread ID and its captures append to the same ledger

#### Scenario: Reload chosen by file age
- **WHEN** the reload chose a handoff by modification time
- **THEN** the fresh session is not bound to any thread, and that fact is recorded where the drift guard and
  auto-answer read it

### Requirement: Absence of a ledger is announced
Where a session has no bound thread or its thread has no human-sourced entry, every consumer of the ledger
SHALL report that absence by name rather than treat it as an empty direction.

#### Scenario: Unbound session reaches a stop
- **WHEN** an unbound session stops with a question
- **THEN** the logged verdict names "no bound thread" as the reason no answer was given
