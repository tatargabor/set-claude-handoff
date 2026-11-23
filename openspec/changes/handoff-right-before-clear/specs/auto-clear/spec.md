## MODIFIED Requirements

### Requirement: An unarmed session is asked once for its handoff
WHEN a watched session is idle, is not opted out, its context has reached the nudge ratio (default
1.0) of the clear threshold, and it has no FRESH arm marker, the executor SHALL type `/handoff` into
it. A session has no fresh marker when it has none, or when its last assistant record is more than the
request window after its marker. Each ask SHALL be recorded before anything is typed, as
`.handoff-nudged-<session8>` and then `.2` and `.3`. A session SHALL be asked again only after it
answered the previous ask (its marker is newer than the latest record), and at most 3 times. The
presence gate holds, and a working turn is waited out.

#### Scenario: Unarmed session approaches the limit
- **WHEN** an idle session without a marker reaches the threshold
- **THEN** `/handoff` is typed once and the record is written; later passes type nothing until it answers

#### Scenario: Stale handoff at the limit
- **WHEN** an idle session at the threshold holds a marker, and its last assistant record is 30 minutes after it
- **THEN** no `/clear` is typed, `/handoff` is typed, and the record `.2` is written

#### Scenario: Already nudged
- **WHEN** the latest record is newer than the session's marker
- **THEN** no nudge is due, whatever its context size

#### Scenario: Asked three times
- **WHEN** three records exist and the handoff is stale again
- **THEN** no nudge is due, and the reason says the session is left to the native compaction

## ADDED Requirements

### Requirement: A clear needs the handoff to be the last act
The marker gate SHALL pass only when this session's marker exists AND its last assistant record
(or, where no record has a timestamp, the transcript's mtime) is at most the request window (default
600 s) after the marker. This SHALL hold on every path that clears or compacts.

#### Scenario: Fresh handoff
- **WHEN** a session at the threshold wrote its handoff and then only its closing report
- **THEN** the marker gate passes and the session is eligible

#### Scenario: Work after the handoff
- **WHEN** a session at the threshold worked 30 minutes after its last handoff
- **THEN** the marker gate fails, naming how far the handoff lags
