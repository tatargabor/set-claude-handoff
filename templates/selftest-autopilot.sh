#!/usr/bin/env bash
# selftest-autopilot — pin the platform behaviors autopilot relies on (tasks 1.1, 1.2).
#
# Measured by live probe on Claude Code 2.1.270 (docs/investigations/2026-09-13-thread-anchor-and-auto-answer.md §5):
#   P1b  PreToolUse(AskUserQuestion) → allow + updatedInput.answers skips the dialog, the model
#        receives the answer                                     → answer-dialog.mjs depends on it
#   P3a  the Stop hook input carries last_assistant_message       → answer-stop.mjs depends on it
#   P3b  an asyncRewake Stop hook that exits 2 wakes the idle session, and a human message typed
#        while it runs does NOT cancel it                         → the stale guard exists for it
# A platform upgrade that changes any of these must fail HERE, loudly — not silently in a thread.
#
# Isolation: a PRIVATE tmux socket (-L autopilot-selftest) and throwaway dirs. It never touches
# the default tmux server (armed watchers and fleet panes live there) or any repo.
# Cost: two short sessions on a small model (default haiku; SELFTEST_MODEL overrides). ~3 minutes.
set -u
SOCK="autopilot-selftest"
MODEL="${SELFTEST_MODEL:-haiku}"
T() { tmux -L "$SOCK" "$@"; }
PASS=0; FAIL=0
ok()   { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
cleanup() { T kill-server 2>/dev/null; }
trap cleanup EXIT

command -v tmux >/dev/null || { echo "tmux required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }

# Wait up to $1 seconds for command "$2…" to succeed.
wait_for() { local n="$1"; shift; for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 1; done; return 1; }

# Start claude in a fresh dir on the private socket; dismiss the first-launch trust dialog
# (measured: it swallows keystrokes exactly like a permission prompt).
launch() { # $1 = name, $2 = dir
  T new-session -d -s "$1" -x 200 -y 50 -c "$2" \
    "env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT claude --model $MODEL"
  sleep 6
  if T capture-pane -p -t "$1" | grep -qi "trust"; then T send-keys -t "$1" Enter; sleep 4; fi
}

# Text and Enter as SEPARATE writes (measured: Enter in the same write can be swallowed).
say() { T send-keys -t "$1" -l "$2"; sleep 1.5; T send-keys -t "$1" Enter; }

transcript_of() { # newest transcript whose project slug ends with the dir's basename
  ls -t "$HOME"/.claude/projects/*"$(basename "$1")"/*.jsonl 2>/dev/null | head -1
}

# ── P1b + P3a ────────────────────────────────────────────────────────────────
D1=$(mktemp -d /tmp/autopilot-selftest-a-XXXXXX)
mkdir -p "$D1/.claude"
cat > "$D1/answer.sh" <<'SH'
#!/usr/bin/env bash
jq -c '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",
  updatedInput:(.tool_input + {answers:(.tool_input.questions|map({(.question):"Blue"})|add)})}}'
SH
cat > "$D1/stop.sh" <<SH
#!/usr/bin/env bash
cat > "$D1/stop-input.json"
SH
chmod +x "$D1"/*.sh
cat > "$D1/.claude/settings.json" <<JSON
{ "hooks": {
  "PreToolUse": [ { "matcher": "AskUserQuestion", "hooks": [ { "type": "command", "command": "$D1/answer.sh" } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "$D1/stop.sh" } ] } ] } }
JSON
launch p1 "$D1"
say p1 "Use the AskUserQuestion tool to ask me whether I prefer red or blue, then tell me in one short sentence what I chose."
if wait_for 120 test -s "$D1/stop-input.json"; then
  TR=$(transcript_of "$D1")
  if [ -n "$TR" ] && grep -q '"answers"' "$TR" && grep -q 'Blue' "$TR"; then ok "P1b  hook-supplied answers reached the model (dialog skipped)"
  else bad "P1b  no hook-supplied answer in the transcript ($TR) — answer-dialog.mjs cannot work on this build"; fi
  if jq -e 'has("last_assistant_message")' "$D1/stop-input.json" >/dev/null; then ok "P3a  Stop input carries last_assistant_message"
  else bad "P3a  Stop input lacks last_assistant_message — answer-stop.mjs has no question text"; fi
else
  bad "P1b/P3a  the session never finished a turn within 120 s (trust dialog? model access?)"
fi

# ── P3b ──────────────────────────────────────────────────────────────────────
D2=$(mktemp -d /tmp/autopilot-selftest-b-XXXXXX)
mkdir -p "$D2/.claude"
cat > "$D2/rewake.sh" <<SH
#!/usr/bin/env bash
cat > /dev/null
[ -e "$D2/once" ] && exit 0
touch "$D2/once"
sleep 15
echo "[selftest] rewake-marker-7f3a"
echo "[selftest] rewake-marker-7f3a" >&2
exit 2
SH
chmod +x "$D2/rewake.sh"
cat > "$D2/.claude/settings.json" <<JSON
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "$D2/rewake.sh", "asyncRewake": true } ] } ] } }
JSON
launch p3 "$D2"
say p3 "Reply with exactly the word hi and nothing else."
if wait_for 90 test -e "$D2/once"; then
  sleep 4
  say p3 "second human message while the hook runs"
  if wait_for 60 sh -c "grep -q 'rewake-marker-7f3a' \"\$(ls -t \"$HOME\"/.claude/projects/*$(basename "$D2")/*.jsonl | head -1)\""; then
    ok "P3b  asyncRewake woke the session and was NOT cancelled by the human's message — the stale guard is required"
  else
    bad "P3b  no rewake delivered within 60 s — asyncRewake changed; re-evaluate answer-stop.mjs before trusting it"
  fi
else
  bad "P3b  the first turn never ended within 90 s"
fi

echo "---"
echo "$PASS passed, $FAIL failed  (model: $MODEL; dirs: $D1 $D2)"
[ "$FAIL" -eq 0 ]
