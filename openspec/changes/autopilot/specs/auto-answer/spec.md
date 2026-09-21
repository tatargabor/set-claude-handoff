## Purpose

Defines when a session's stop — a question dialog, a prose question, or a "done, what next?" turn end — may
be answered without the human: only when the human's own recorded words in the thread already settle it,
with the answer labeled as automatic and never mistaken for a new human decision.

## ADDED Requirements

### Requirement: An answer requires verbatim human evidence from this thread
An automatic answer SHALL be given only when every piece of cited evidence is a verbatim quote of a
human-sourced ledger entry of the session's bound thread, and the answer follows from that evidence. An answer
whose evidence cannot be found verbatim MUST NOT be given, whatever confidence the judge reports.

#### Scenario: Question already answered earlier in the thread
- **WHEN** the session asks whether to continue the resolver fixes and the ledger holds the human's earlier
  "igen, javítsd a resolver három hibáját"
- **THEN** the session receives the answer with that quote cited

#### Scenario: Judge cites text that is not in the ledger
- **WHEN** the judge's evidence quote is not a verbatim substring of any human-sourced entry of the thread
- **THEN** no answer is given and the verdict records the failed evidence check

### Requirement: Some stops are never answered
No automatic answer SHALL be given when the question asks for information the ledger does not contain (a new
decision), when it concerns an item the bound handoff lists as waiting on a user decision, when the question or
answer matches the profile's deny-list of irreversible or outward actions, when the session is not bound to a
thread, or when the silence budget is exhausted.

#### Scenario: Genuinely new decision
- **WHEN** the session asks which of two designs to build and nothing in the thread's ledger chooses between
  them
- **THEN** the stop is left for the human and the verdict logs `NEW`

#### Scenario: Deny-listed action
- **WHEN** the question is whether to push to the main branch and a human quote would otherwise support it
- **THEN** no answer is given and the verdict names the deny-list match

### Requirement: Both derivable answers and approvals are answered whenever the evidence holds
Within the rules above, the capability SHALL answer both a question the evidence answers directly and a
request for approval to proceed with a step the evidence shows is within the thread's human direction —
immediately, whether or not the human is present (user decision, 2026-09-13).

#### Scenario: Approval to continue with the thread's next step
- **WHEN** the session ends its turn asking "shall I continue with the next group?" and the human's direction
  quoted in the ledger covers working through the groups
- **THEN** the session is answered to continue, with the quote cited

### Requirement: Question dialogs are answered in-protocol
An `AskUserQuestion` dialog SHALL be answered through the tool's own input before the dialog shows, never by
keystrokes. When not every question in the call can be answered under the evidence rule, the dialog SHALL be
shown to the human unchanged.

#### Scenario: Dialog with one answerable and one new question
- **WHEN** one question of a two-question dialog is derivable and the other is new
- **THEN** the dialog is shown to the human with both questions, and no partial answer is injected

### Requirement: Every automatic answer is labeled and recorded
The answer text SHALL state that it is automatic and quote its evidence with the evidence's time; the ledger
SHALL record it as `auto-answer`; the verdict log SHALL record the stop, the class, the evidence check and the
outcome — including every stop that was not answered.

#### Scenario: Human reads the session later
- **WHEN** the human scrolls back over an automatically answered stop
- **THEN** the answer itself says it was automatic and which of the human's words it relied on

### Requirement: A stale automatic answer is never delivered
An answer computed in the background after a turn ended SHALL be delivered only if, at the moment of delivery,
the session has received no new input and produced no new turn since the stop it answers.

#### Scenario: Human types while the answer is being computed
- **WHEN** the human submits a message after the stop and before the background answer is ready
- **THEN** the background answer is discarded and the discard is logged

### Requirement: Autopilot can be switched off by file, per tree and per session
A kill-switch file for the tree and one for a single session SHALL each disable automatic answers and
automatic continuations for their scope, whatever else holds. The switches SHALL be independent of the
auto-clear switches.

#### Scenario: Session opt-out
- **WHEN** the session's autopilot opt-out file exists
- **THEN** its stops are not answered and it is not auto-continued, while auto-clear may still clear it

### Requirement: The human switches autopilot on and off from the prompt, at any time
A human-typed prompt that contains an explicit autopilot directive (by default `autopilot off` / `autopilot ki`
/ `autopilot on` / `autopilot be`, extensible in the profile; the word `project` widens the scope from the
session to the tree) SHALL take effect at capture time — before the agent processes the prompt — by creating
or removing the corresponding kill-switch file, independent of anything the agent does. The session SHALL be
told the new state in the same turn. A `machine-typed` or `mixed` prompt MUST NOT change the switch.
Switching back on SHALL work at any time after arming (user requirement, 2026-09-13).

#### Scenario: Human turns autopilot off mid-thread
- **WHEN** the human submits "autopilot ki, ezt most én viszem" in an armed session
- **THEN** the session's opt-out file exists before the agent's turn starts, the agent is told autopilot is
  off for this session, and no later stop of the session is answered or auto-continued

#### Scenario: Human turns it back on
- **WHEN** the human later submits "autopilot be" in the same session
- **THEN** the session's opt-out file is removed and the next qualifying stop is evaluated again

#### Scenario: A machine prompt contains the directive words
- **WHEN** a watcher-typed or fused prompt contains "autopilot off"
- **THEN** the switch does not change and the capture log records the ignored directive

### Requirement: Waiting on background work is a stop that may continue in parallel
When a turn ends while harness-tracked background work of the session is still running, the stop SHALL be
answered with "continue with <step> while it runs" only if the step is backed by verbatim human evidence under
the evidence rule AND the agent's own final message states that the step does not depend on the running
work's result. Otherwise the stop SHALL NOT be answered — the background work's completion notification wakes
the session, as today. A prompt suggestion offered by the client is agent-authored and is never evidence.

#### Scenario: Experiment running, independent cheap steps offered
- **WHEN** a session ends its turn with a background experiment still running, its message says two other
  steps can be done before the experiment finishes, and the human's recorded direction covers that work
- **THEN** the session is told to continue with those steps while the experiment runs, with the quotes cited

#### Scenario: The next step needs the running result
- **WHEN** the only next step the message names is scoring the result of the running experiment
- **THEN** no answer is given and the session waits for the completion notification

### Requirement: Answering never recurses into the judge's own session
The judge run that evaluates a stop SHALL NOT trigger capture, drift-guard or auto-answer hooks of its own.

#### Scenario: Judge runs inside the project directory
- **WHEN** the judge is launched as a headless session in the project's directory
- **THEN** no ledger entry, verdict or answer is produced for the judge's session
