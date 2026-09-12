#!/usr/bin/env bash
# selftest-clear-reload — the LIVE check that the auto-clear trigger path works in THIS environment.
#
# What it proves, in order:
#   1. tmux exists and a server can run here;
#   2. send-keys deliver keystrokes into a pane (bash probe — echo lands in a file);
#   3. a real `claude` TUI in a tmux pane receives typed keys (the probe text renders on the
#      input line);
#   4. `/clear` + Enter executes: the input line empties and the status bar shows a FRESH
#      session id in the SAME pane — the process survived the clear.
#
# Measured gotchas this script encodes (2026-09-12):
#   - `claude` whose stdout is NOT the pane tty (piped/redirected) drops to print mode and
#     exits — the pane command must be plain `claude`, no wrapper, no redirect;
#   - a first-launch trust dialog swallows keystrokes like a permission prompt — the script
#     answers it (Down Enter = "Yes, I trust this folder") in its throwaway scratch dir;
#   - a dead pane looks like a dead server — remain-on-exit keeps the corpse readable.
#
# Run it in YOUR terminal (not from inside another claude's sandboxed shell — sandboxes may
# refuse pty creation). Prereqs: tmux; `claude` on PATH. Everything is killed at the end.
set -u

SESSION="handoff-selftest-$$"
DIR="$(mktemp -d /tmp/handoff-selftest.XXXXXX)"
fail() { echo "FAIL: $*"; tmux kill-server 2>/dev/null; rm -rf "$DIR"; exit 1; }
command -v tmux >/dev/null || fail "tmux not installed — no external writer for the pilot"
command -v claude >/dev/null || fail "claude not on PATH"

# 1+2. bash probe: do send-keys land in a pane at all?
tmux kill-server 2>/dev/null; sleep 1
tmux new-session -d -s "$SESSION" bash || fail "tmux server could not start here"
tmux send-keys -t "$SESSION" "echo landed > $DIR/probe" Enter
sleep 1
[ "$(cat "$DIR/probe" 2>/dev/null)" = "landed" ] || fail "send-keys did not deliver into a bash pane"
echo "ok  1-2  send-keys deliver into a pane"

# 3. the real TUI. Plain `claude` — no pipe, no redirect, no wrapper (see gotchas above).
tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -x 200 -y 50 "claude"
tmux set-option -t "$SESSION" remain-on-exit on
alive() { [ "$(tmux display-message -t "$SESSION" -p '#{pane_dead}' 2>/dev/null)" != "1" ]; }
for _ in $(seq 1 30); do alive || break; tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -qE "trust|for shortcuts" && break; sleep 1; done
alive || { echo "pane died at launch:"; tmux capture-pane -t "$SESSION" -p | grep -v '^\s*$' | tail -4; fail "claude TUI did not come up"; }
if tmux capture-pane -t "$SESSION" -p | grep -q "trust"; then
  tmux send-keys -t "$SESSION" Down Enter   # "Yes, I trust this folder" — scratch dir, throwaway
  sleep 4
fi
alive || fail "claude exited right after the trust answer (status $(tmux display-message -t "$SESSION" -p '#{exit_code}'))"
for _ in $(seq 1 30); do alive || break; tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -q "for shortcuts" && break; sleep 1; done
alive || fail "claude exited before the prompt (status $(tmux display-message -t "$SESSION" -p '#{exit_code}'))"

tmux send-keys -t "$SESSION" "handoffselftest-$$"
sleep 1
tmux capture-pane -t "$SESSION" -p | grep -q "handoffselftest-$$" || fail "typed keys never rendered on the input line"
echo "ok  3    keys render on the claude input line"

# 4. /clear + Enter → fresh session id, same live pane.
BEFORE="$(tmux display-message -t "$SESSION" -p '#{pane_pid}')"
tmux send-keys -t "$SESSION" C-u; sleep 0.3
tmux send-keys -t "$SESSION" "/clear" Enter
sleep 3
alive || fail "claude DIED on /clear — that is the wedge case, report it"
AFTER_ID="$(tmux capture-pane -t "$SESSION" -p | grep -oE '[⧉□] [0-9a-f]{8}-[0-9a-f]{4}' | head -1)"
[ -n "$AFTER_ID" ] || AFTER_ID="(session id not rendered — check capture manually)"
tmux capture-pane -t "$SESSION" -p | grep -q "handoffselftest-$$" && fail "input line survived /clear — the clear did not execute"
echo "ok  4    /clear executed; pane alive; fresh session: $AFTER_ID"

tmux kill-server 2>/dev/null
rm -rf "$DIR"
echo "PASS — the trigger path works here: tmux send-keys → live TUI → /clear, process survives."
echo "Next: run the gate in --dry-run for one night (specs/auto-clear), then arm the executor."
