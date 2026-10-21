## ADDED Requirements

### Requirement: Compact instead of clear while background work runs
When enabled, and the only gate refusing a clear is running background work, the gate SHALL return the action
`compact` provided the session's own handoff marker exists, the session is idle, no opt-out is present, and its context
is at least the compact threshold. The executor SHALL then issue `/compact` (never `/clear`) through the same presence,
turn, fire-lock and disk checks, SHALL remove the session's marker afterwards, and MAY send a continue prompt naming the
handoff once the session is idle again.

#### Scenario: Lead session with running subagents
- **WHEN** compact-on-background is enabled, a session has 380 000 tokens, its own marker, is idle, and its handoff declares running background agents
- **THEN** the verdict is not eligible for a clear, its action is `compact`, and the watcher types `/compact` and removes `.written-<session8>`

#### Scenario: Disabled by default
- **WHEN** the same session is evaluated without the flag
- **THEN** the action is null and nothing is typed
