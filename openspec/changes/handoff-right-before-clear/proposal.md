## Why

The size path clears a session whose handoff can be far behind its work. The arm nudge asks for the
handoff once, at 60 % of the threshold, which is 240k at today's 400k. The marker that handoff leaves
then arms the clear at 400k, so everything the session did between the two is lost. Nothing refuses
it: only the request path and the warm-idle trigger check that the handoff was the session's last
act. The 0.6 was never measured; it followed the threshold from 320k (192k) to 400k (240k). The
consumer audit of 2026-11-23 found more than 30 min of work after the last handoff write in 6 of 15
automatic-clear pairs.

The owner's rule (2026-11-23): the handoff runs right before the clear. It is asked for at the
threshold, and the clear follows only once it exists.

## What Changes

- **The marker gate requires a fresh handoff.** A marker counts only when the handoff was the
  session's last act: the last assistant record is no more than `--request-window` (600 s) after the
  marker. A stale marker fails the gate with the age it lagged by, on every path: size, request,
  warm-idle and compact-on-background.
- **The handoff is asked for at the threshold.** The nudge ratio defaults to 1.0. At the threshold an
  unarmed OR stale session gets `/handoff`, and the clear follows at the next idle verdict.
- **A refresh, bounded.** A session whose handoff went stale may be asked again: at most 3 times in
  its life, and only after the previous ask was answered (its marker is newer than the last record).
  A session that ignores the ask is not asked again; it is left to the native compaction, and the
  log says so.

## Capabilities

### New Capabilities

### Modified Capabilities
- `auto-clear`: the marker gate requires the handoff to be the last act; the arm nudge happens at the
  threshold and can refresh a stale handoff, bounded.

## Impact

- `templates/clear-gate.mjs` (marker freshness, nudge ratio 1.0, numbered nudge records),
  `templates/watch-auto-clear.sh` (creates the record the verdict names), the skill, the README and
  the tests.
