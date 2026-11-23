## Why

`/auto-clear` starts the watcher with `--started-after now`, and set-core's default install writes
`--started-after <install time>`. The filter has a real reason: hooks are loaded per process, so a
process older than the clear-reload wiring would reload nothing after a `/clear`. But the filter also
excludes the session that armed auto-clear, which is usually the very session the user wanted covered.
Nothing tells anyone. Measured 2026-11-23 in one product family's trees:
- one tree's only working session was skipped 2858 times, and every one of its 6 compactions in the
  window happened unprotected;
- in another tree two sessions were skipped 4926 and 3421 times.

The log line `skip … started before --started-after` repeated every minute is the only trace, and
nobody reads it.

## What Changes

- **Announced once, where the user looks.** The first time the watcher skips a session for
  `--started-after`, it writes `.set/handoff/.excluded-<session8>`, holding the reason and the way
  out. It logs the skip once, not every pass. The keep-going/statusline path, or the next /handoff,
  surfaces that file to the session. The session is never typed into: an excluded session is exactly
  the one that cannot be trusted to reload.
- **The way out is named.** A `claude --resume <id>` restarts the process with the same session id,
  so its new runtime record postdates the filter and its hooks are current. The marker gate already
  treats a restored process of the same id as the same thread. The `/auto-clear` skill says this to
  the arming session in the same turn ("this session is excluded; resume it to be covered").
- **The filter measures the wiring, not the arming.** `--started-after` defaults to the moment the
  reload hook entered the tree's settings, not "now", when that moment can be read from a file. That
  moment is the mtime of the settings file, set when init wired the hook, or a stamp init writes. A
  watcher restart then stops excluding sessions that already had the hook.

## Capabilities

### New Capabilities

### Modified Capabilities
- `auto-clear`: a session excluded by `--started-after` is announced once, with a way out, and the
  filter's default moment is the wiring time.

## Impact

- `templates/watch-auto-clear.sh` (once-per-session skip, exclusion record), `bin/cli.mjs` (a wiring
  stamp at `init --auto-clear`), `skills/auto-clear/SKILL.md`, and the reader of the record (keep-going
  or the handoff skill), with tests.
- set-core's `auto-clear-default-install` should read the same stamp instead of writing its own
  install time.
