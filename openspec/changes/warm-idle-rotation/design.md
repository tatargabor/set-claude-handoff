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

A second, larger sample (measured 2026-11-23, same method, one product family's consumer trees, every
`trigger: auto` compaction since 2026-11-01 with a readable transcript, n=348):

| compactions | n | after ≥ 45 min idle | idle before it (median) |
|---|---|---|---|
| below 250k (200–243k) | 40 | 40 | 54.8 min |
| at or above 250k | 308 | 82 | 1.0 min |

So about 122 of 348 (≈ 35 %) were idle-triggered, and not one compaction under 250k was size-driven.
No size threshold reaches these; only a timer does.

**The idle compaction starts about a minute before its record.** In one consumer session that has a
`PreCompact` hook (8b72528a, 2026-11-07), the last turn ended at 17:20:56Z. The hook ran at 18:14:45Z,
53.8 min idle, and read exactly that transcript (974 lines, nothing after the turn end). The
`compact_boundary` record was written at 18:15:57Z, 55.0 min idle. The "54.7 min" measured from the
records therefore marks the END of the summary call. The deadline for typing anything is ~53.8 min,
and the 54-minute stop (D2) is the upper edge of that, not a margin under it.

### Answers to the measure-first tasks

- **1.2 — the runtime's idle compaction is documented, and has its own settings.** It is called
  *idle compaction* (https://code.claude.com/docs/en/settings-reference.md, `idleCompaction`). It runs
  when the conversation is on the one-hour prompt cache TTL, its context has reached a token
  threshold, and "about an hour has passed since the last request". Its settings:
  - `idleCompaction`: boolean, default `true`; `false` turns it off. Since 2.1.290.
  - `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`: its own floor, default 200 000, values under 100 000 are
    raised to 100 000 (https://code.claude.com/docs/en/env-vars.md).
  - `autoCompactEnabled: false` and `DISABLE_AUTO_COMPACT` turn it off together with the size
    compaction.
  - `autoCompactWindow` does not touch it.

  The idle time itself is not a setting, and the docs give no number beyond "about an hour". So
  `--idle-floor` defaults to the documented 200 000 (D4). A tree that sets
  `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` passes the same number to the watcher. A tree with
  `idleCompaction: false` loses the compaction case but keeps the cache-write cost case of Why.
- **1.3 — tokens one turn adds** (main-thread transcripts on this machine, last 7 days, 2034 files,
  7444 turns; a turn is a typed user message to the next one, and the delta is between the last usage
  triples before each, with compaction boundaries excluded):

  | p50 | p90 | p95 | p99 | max |
  |---|---|---|---|---|
  | 593 | 12 255 | 23 481 | 67 887 | 369 167 |

  The margin for a later relative size threshold is therefore ~24k at p95 and ~68k at p99. This change
  records the numbers only; it does not change behaviour.
- **1.4 — `PreCompact` fires on an automatic compaction, including the idle one.** This is
  documented (https://code.claude.com/docs/en/hooks.md: matcher `auto` = "Auto-compact when the
  conversation reaches the auto-compact window, and idle compaction"). It was also observed once
  (n=1, the 8b72528a case above: an idle compaction, the hook ran 72 s before the record).
  - The hook's input carries `trigger: manual|auto`. No field tells the idle case from the size
    case.
  - The hook can BLOCK the compaction: exit 2, or `"decision": "block"`. A proactive compaction is
    then skipped and the conversation continues uncompacted.
  - Both facts belong to the backstop, which is a separate change, as planned.

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
- [Whether this idle compaction has its own setting] → answered by 1.2 (Context): `idleCompaction` and
  `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` exist; the idle time does not. A tree that moves the floor
  passes the same number as `--idle-floor`.

## Migration Plan

Ships with the next template upgrade; on by default. Rollback: `--idle-minutes 0` in a unit, or the
previous template.
