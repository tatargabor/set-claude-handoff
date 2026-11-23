## Context

The filter exists for one measured danger: a process older than the reload wiring cannot reload after
`/clear`, because its hook snapshot predates the hook. In a consumer tree's seat (2026-09-13), a
`/clear` loaded nothing until that process restarted. The filter is right to exclude such a process.
What is wrong is that the exclusion is silent, and that its default moment is the arming, not the
wiring.

## Decisions

### D1 — Never type into an excluded session
The notice goes into a record file the session's own hooks read. Typing a message into the pane would
be a prompt, and the excluded session is the one whose hooks are stale.

### D2 — The wiring time, from a stamp init writes
The settings file's mtime moves on any edit, so it would exclude more than needed. A stamp written by
`init --auto-clear` when it wires the reload hook is exact. When no stamp exists, the current behaviour
(an explicit `--started-after`) stays.

## Risks / Trade-offs

- [A resumed process might not reload hooks on this runtime] → task 1.1 probes it before the skill
  recommends it.
