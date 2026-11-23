## Why

A consumer product family asked (2026-11-08) for a way to wire the handoff and auto-clear hooks with no
per-repo copy. Two of its repos carry byte-identical copies of the seven hooks in `.claude/hooks/`, and a
third has the originals. The copies drift. Tonight's rollout had to touch every tree one by one, and one
family's plugin vendors an old `keep-going` with a pinned `--threshold 550000`. `init --global` installs
only the skill. The bus package solved the same problem with `sac plugin-files`: portable hook lines that
call the user-installed binary, have no machine path, and stand down where a project still wires its own copy.

## What Changes

- `set-claude-handoff hook <arm|reinject|keep-going> [args…] [--from-plugin]` runs the package's own hook
  template with the hook's stdin. With `--from-plugin` it stands down, silently, in a project whose
  settings still wire that hook itself, so the hook never fires twice.
- `set-claude-handoff watch --dir <tree> [watcher flags…]` runs the package's watcher with the package's gate,
  presence and turn-state checks. A unit needs no per-repo watcher copy.
- `set-claude-handoff plugin-files <plugin-dir> [--keep-going] [--dry-run]` merges the portable hook lines
  into `<plugin-dir>/hooks/hooks.json`. It replaces only its own entries, keeps every other hook, and warns
  when the file also wires a vendored copy of the same hook.
- The watcher writes a heartbeat (`.set/handoff/.watcher-alive`) every pass. keep-going's "is a watcher here"
  check (M5) accepts that heartbeat as well as a per-repo watcher file, so a tree without copies still gets
  the handoff demand at the limit.
- A SessionStart line on a machine without the binary announces that the reload is off. It does not stay silent.

Out of scope: the user-level settings route (`init --global --auto-clear`), shipping the skills through the
plugin, and removing the consumer copies (the consumer does that after this lands).

## Impact

`bin/cli.mjs`, `templates/watch-auto-clear.sh`, `templates/keep-going.mjs`, README, the auto-clear skill, tests.
Existing per-repo installs are unchanged.
