## Context

Measured 2026-11-23 (method, so it can be re-run: for each `compact_boundary` with `trigger: auto`,
the timestamp gap to the nearest preceding assistant record in the same transcript; main-thread
transcripts, last 7 days):

| compactions | n | idle before it (median) | note |
|---|---|---|---|
| below 320k | 80 | 54.8 min (p25 54.6, p75 54.9) | no large input before them; lowest in the month 200k |
| at 360–380k | 113 | 0.1 min | the size threshold |

The duration split seen earlier is the same split: a 40–50 s compaction is a summary made at that
moment (idle), a ~30 ms one a precomputed summary (size). The size threshold (default 320k from
`3c9306b`, 400k from `e4bd96c` with the native window at 550k) is ahead of the size compaction in
about half the cases at 320k and can never be ahead of the
idle one. The prompt cache expires after an hour; the idle compaction lands just before it.

## Goals / Non-Goals

**Goals:** catch the idle compaction before it happens, with a handoff, on a warm cache; keep one
executor and every existing gate.

**Non-Goals:** changing what the runtime does; a fleet-side typist; the relative size threshold and
the `PreCompact` backstop are in this change only as measured-first tasks, not as requirements.

## Decisions

### D1 — Idle is read from the transcript, not from the process
The gate already reads the transcript tail; the age of the last assistant record is the same clock
the runtime's idle compaction uses (the measurement above was taken that way). A process or pane
idleness reading would measure the human, not the API.

### D2 — 48 minutes default, a hard stop at 54
A handoff turn plus the `/clear` and the continue prompt take minutes, and the watcher polls every
60 s, so the trigger needs room before 54.6. 48 leaves two polls of slack for a turn that runs long.
Past 54 minutes a clear without a handoff would lose the thread for nothing — the runtime is about to
compact it anyway and a summary beats nothing — so the late case logs and leaves it alone.

### D3 — Reuse the arm-nudge record
The `/handoff` typed by the idle trigger writes the same `.handoff-nudged-<session8>` record. A
session is asked for its handoff once in its life, whichever trigger asked.

### D4 — The floor is 200k because the runtime's floor is
No idle compaction below 200k was seen in a month; below it the session survives the cold wake and
the cost case is weaker.

## Risks / Trade-offs

- [A human steps away for 48 minutes mid-thought] → the presence gate still holds (typed text in the
  input line blocks), the session must be armed by its own handoff before any clear, and
  `.no-autoclear` opts out.
- [The runtime changes its idle timing] → the 54-minute stop is a constant; the measurement method is
  in Context so it can be re-run, and the watcher logs every missed window.
- [Whether this idle compaction has its own setting] → unknown; task 1.2 looks it up before building.

## Migration Plan

Ships with the next template upgrade; on by default. Rollback: `--idle-minutes 0` in a unit, or the
previous template.
