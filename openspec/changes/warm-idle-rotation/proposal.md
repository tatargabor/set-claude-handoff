## Why

The fixed 320k clear threshold loses the race to the runtime's own compaction in a large share of
sessions, and on 2026-11-23 the cause of most losses was measured: they are not size-driven at all.
Over the last 7 days, automatic compactions below 320k (n=80, main-thread transcripts) came a median
**54.8 minutes** after the session's last API call (p25 54.6, p75 54.9), with no large input before
them; compactions at the size threshold (360–380k, n=113) came a median 0.1 minutes after it. The
lowest such idle compaction in the month was at 200k. So the runtime compacts an idle session of
200k+ at ~54.7 minutes idle, just before the one-hour prompt-cache expiry — and no size threshold can
precede that. A timer can. The same idle wake is also expensive: in one week, 193 calls followed a
gap over 55 minutes, 113 of them re-wrote more than 100k tokens to cache — 22.5M tokens, 15% of all
cache writes. Handing off and clearing while the cache is still warm removes both costs.

## What Changes

- **Warm-idle rotation:** the watcher gets a second trigger beside the size threshold. A session
  that is between turns, has had no API call for `--idle-minutes` (default 48), and holds at least
  `--idle-floor` tokens (default 200000) is asked for its handoff (when unarmed) and cleared once the
  handoff passes the gate — before the runtime's idle compaction at ~54.6 minutes. Same executor,
  same presence and turn gates, same fire lock; never a second typist.
- **Relative size threshold (measured first):** the clear threshold becomes the session's own
  compaction point minus a margin — the point from the statusline payload's context window size
  times the measured trigger ratio, the margin the p95 of tokens one turn adds. Until the margin is
  measured, the 320k default stays.
- **Compaction backstop (probe first):** a `PreCompact` hook that writes the handoff when the race is
  lost anyway — only if a probe shows it fires on automatic compaction.
- The existing arm nudge stays; the warm-idle trigger reuses its record so a session is never asked
  twice.

## Capabilities

### New Capabilities

### Modified Capabilities
- `auto-clear`: a second, time-based trigger (warm-idle rotation); the size threshold may become
  relative once its margin is measured.

## Impact

- `templates/clear-gate.mjs` (idle verdict from the transcript's last assistant record),
  `templates/watch-auto-clear.sh` (the second trigger, flags, log lines), tests.
- Every watcher picks it up on the next template upgrade; the flags default on.
- Cost: one handoff turn on a warm cache instead of a cold re-read or a native compaction summary.
