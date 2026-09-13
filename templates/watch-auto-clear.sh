#!/usr/bin/env bash
# watch-auto-clear — the EXECUTOR of the auto-clear capability (specs: auto-clear).
#
# Loop: enumerate the runtime's live session records (~/.claude/sessions/<pid>.json), keep the
# ones belonging to --dir, evaluate the clear-gate for each, and — only when every gate holds —
# type `/clear` into the tmux pane that hosts the session. It is self-limiting by construction:
# after a clear the fresh session has no handoff marker, so it stays unarmed until its own next
# handoff passes the content gate. The gate only evaluates; THIS script is the only thing that
# types, and it types only on an eligible verdict.
#
# Safety properties (kept even when armed):
#   - every gate verdict is logged, pass or fail — absence is announced, never silent;
#   - --dry-run evaluates and logs without ever sending keys;
#   - --started-after drops sessions started before a moment (e.g. before the clear-reload
#     hook was wired into settings — clearing a session that cannot reload is the one really
#     dangerous combination);
#   - a session with no writer path is skipped with a logged reason: no tmux pane hosts it
#     AND no fleet agent (ownerd roster, matched by pid) holds it.
#
# Writers, in order (9.2, measured 2026-09-13: 65 overnight skips of ELIGIBLE sessions whose
# ownerd-held pty no tmux pane hosts):
#   1. tmux send-keys into the pane whose descendant the session pid is;
#   2. OwnerClient.write to the fleet agent whose roster pid matches — ESC + C-U + "/clear\r",
#      the shape measured working on a live fleet-held agent. Read-only fallback if neither
#      exists: the skip is logged, never silent.
#
# Sessions are matched against EVERY worktree of --dir (9.1, measured: a worktree agent's cwd
# is the worktree, and its handoff dir lives there too — gating it against the main tree
# would read the wrong marker and the wrong handoff).
#
# Usage:
#   watch-auto-clear.sh --dir <projectRoot> [--interval SEC] [--threshold N] [--freshness SEC]
#     [--background-work-blocks true|false] [--started-after ISO] [--gate PATH] [--dry-run]
#     [--auto-continue PROMPT] [--continue-delay SEC]
#
# Run it under tmux/systemd/nohup — it must outlive the sessions it watches. Runtime state:
#   <root>/.set/handoff/auto-clear.log     one line per verdict
set -u

DIR=""; INTERVAL=60; THRESHOLD=""; FRESHNESS=""; BG="true"; AFTER=""; GATE=""; DRY=0
CONTINUE_PROMPT=""; CONTINUE_DELAY=20
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --threshold) THRESHOLD="$2"; shift 2;;
    --freshness) FRESHNESS="$2"; shift 2;;
    --background-work-blocks) BG="$2"; shift 2;;
    --started-after) AFTER="$2"; shift 2;;
    --gate) GATE="$2"; shift 2;;
    --auto-continue) CONTINUE_PROMPT="$2"; shift 2;;
    --continue-delay) CONTINUE_DELAY="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done
[ -n "$DIR" ] || { echo "--dir is required" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
GATE="${GATE:-$DIR/.claude/hooks/clear-gate.mjs}"
[ -f "$GATE" ] || { echo "gate not found: $GATE" >&2; exit 2; }

LOG="$DIR/.set/handoff/auto-clear.log"
mkdir -p "$(dirname "$LOG")"
AFTER_MS=""; [ -n "$AFTER" ] && AFTER_MS=$(date -d "$AFTER" +%s%3N 2>/dev/null)

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

if ! command -v tmux >/dev/null; then
  if python3 -c "import set_orch.fleet.owner_client" >/dev/null 2>&1; then
    log "tmux not available — the writer path is the fleet owner only"
  else
    echo "tmux not available and the fleet owner client is not importable — no writer path" >&2
    exit 2
  fi
fi

# Every worktree of DIR is a legitimate session cwd — and each tree gates from ITS OWN
# .set/handoff (9.1). The main tree is first; worktree enumeration failing (plain dir, no
# git) leaves the main tree alone, which is the pre-9.1 behavior.
WORKTREES="$DIR"
while IFS= read -r wt; do
  [ -n "$wt" ] && [ "$wt" != "$DIR" ] && WORKTREES="$WORKTREES
$wt"
done < <(git -C "$DIR" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')

tree_of() { printf '%s\n' "$WORKTREES" | grep -Fx "$1"; }

# The fleet-owner writer (9.2): roster lookup by pid, then the measured keystroke shape.
fleet_label_for_pid() {
  [ -n "${1:-}" ] || return 0
  python3 - "$1" <<'PY' 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    pid = int(sys.argv[1])
    for a in OwnerClient().list_agents():
        if a.get("pid") == pid:
            print(a.get("label", ""))
            break
except Exception:
    pass
PY
}

fleet_write_clear() {
  python3 - "$1" <<'PY' 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    # ESC dismisses any open dialog; C-U kills the input line (a half-typed command must not
    # be completed by our keystrokes); then the command. Measured working shape.
    written = OwnerClient().write(sys.argv[1], b"\x1b\x15/clear\r")
    sys.exit(0 if written else 1)
except Exception:
    sys.exit(1)
PY
}

# Step 5 of the cycle (--auto-continue, user ask 2026-09-13: "why we do the clear and reload
# is to continue work"): after a successful automatic clear, give the fresh session its first
# prompt — continue from the reloaded handoff. Fires ONLY after the watcher's own clears, never
# after a manual /clear (a human at the keyboard decides that themselves).
#
# MEASURED (2026-09-13, the second bugfix fire): text+Enter in ONE write raced the fresh
# session's SessionStart hook chain (timeouts up to 40s) — the TUI was not reading the pty yet,
# the Enter was swallowed, and the prompt sat in the input box until the user pressed it by
# hand. So: text first, Enter separately, then VERIFY from the pid's own fresh transcript
# (the runtime record rewrites sessionId on a clear) and re-press Enter up to 3× if needed.
verify_submitted() { # $1 = pid, $2 = fragment expected in the fresh transcript
  local sid slug
  sid=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$1.json" 2>/dev/null)
  [ -n "$sid" ] || return 1
  slug=$(jq -r '.cwd // empty' "$HOME/.claude/sessions/$1.json" 2>/dev/null | sed 's/\//-/g')
  [ -n "$slug" ] || return 1
  local t="$HOME/.claude/projects/$slug/$sid.jsonl"
  [ -f "$t" ] && grep -qF -- "$2" "$t"
}

continue_finish() { # $1 = pid, $2 = where (log label), $3.. = how to press Enter again
  local pid="$1" where="$2" try
  shift 2
  local fragment="${CONTINUE_FRAGMENT:-auto-continue}"
  for try in 1 2 3; do
    sleep 5
    if verify_submitted "$pid" "$fragment"; then
      log "CONTINUE confirmed  prompt submitted (try $try) → $where"
      return 0
    fi
    [ "$try" -le 2 ] && "$@"
  done
  log "CONTINUE UNCONFIRMED  prompt not found in the fresh transcript after 3 tries → $where"
}

continue_tmux() { # $1 = pane, $2 = pid
  [ -n "$CONTINUE_PROMPT" ] || return 0
  sleep "$CONTINUE_DELAY"
  tmux send-keys -t "$1" C-u
  sleep 0.3
  tmux send-keys -t "$1" "$CONTINUE_PROMPT"
  sleep 1.5
  tmux send-keys -t "$1" Enter
  log "CONTINUE sent  auto-continue prompt → pane $1"
  continue_finish "$2" "pane $1" tmux send-keys -t "$1" Enter
}
continue_owner() { # $1 = fleet label, $2 = pid
  [ -n "$CONTINUE_PROMPT" ] || return 0
  sleep "$CONTINUE_DELAY"
  python3 - "$1" "$CONTINUE_PROMPT" <<'PY' 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    data = b"\x15" + sys.argv[2].encode("utf-8")          # C-U, then the text — NO Enter yet
    sys.exit(0 if OwnerClient().write(sys.argv[1], data) else 1)
except Exception:
    sys.exit(1)
PY
  sleep 1.5
  fleet_owner_enter "$1"
  log "CONTINUE sent  auto-continue prompt → fleet agent $1"
  continue_finish "$2" "fleet agent $1" fleet_owner_enter "$1"
}
fleet_owner_enter() {
  python3 - "$1" <<'PY' 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    OwnerClient().write(sys.argv[1], b"\r")
except Exception:
    pass
PY
}

# Is pid $1 a descendant of tmux pane pid $2? Walks the /proc parent chain.
is_descendant() {
  local p="$1" want="$2"
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    [ "$p" = "$want" ] && return 0
    p=$(sed -E 's/^[0-9]+ \([^)]*\) //' "/proc/$p/stat" 2>/dev/null | awk '{print $2}')
  done
  return 1
}

log "watcher started dir=$DIR interval=${INTERVAL}s threshold=${THRESHOLD:-default} bg-blocks=$BG started-after=${AFTER:-any} dry-run=$DRY auto-continue=$([ -n "$CONTINUE_PROMPT" ] && echo on || echo off)"
while :; do
  for rec in "$HOME"/.claude/sessions/*.json; do
    [ -f "$rec" ] || continue
    sid=$(jq -r '.sessionId // empty' "$rec" 2>/dev/null) || continue
    cwd=$(jq -r '.cwd // empty' "$rec" 2>/dev/null)
    tree=$(tree_of "$cwd")
    [ -n "$tree" ] || continue
    [ -n "$sid" ] || continue
    if [ -n "$AFTER_MS" ]; then
      started=$(jq -r '.startedAt // 0' "$rec" 2>/dev/null)
      [ "${started:-0}" -ge "$AFTER_MS" ] 2>/dev/null || { log "skip  $sid  started before --started-after"; continue; }
    fi
    slug=$(printf '%s' "$cwd" | sed 's/\//-/g')
    transcript="$HOME/.claude/projects/$slug/$sid.jsonl"
    gate_args=(--session "$sid" --transcript "$transcript" --dir "$tree/.set/handoff" --json --background-work-blocks "$BG")
    [ -n "$THRESHOLD" ] && gate_args+=(--threshold "$THRESHOLD")
    [ -n "$FRESHNESS" ] && gate_args+=(--freshness "$FRESHNESS")
    verdict=$(node "$GATE" "${gate_args[@]}" 2>/dev/null) || { log "skip  $sid  gate errored"; continue; }
    eligible=$(printf '%s' "$verdict" | jq -r '.eligible // false')
    failed=$(printf '%s' "$verdict" | jq -r '[.gates[] | select(.ok == false) | .name + ":" + .detail] | join("; ")')
    if [ "$eligible" != "true" ]; then
      log "no    $sid  $failed"
      continue
    fi
    # Eligible — find the tmux pane hosting this session's process.
    pane=""; pane_pid=$(jq -r '.pid // empty' "$rec" 2>/dev/null)
    while IFS=$'\t' read -r pp loc; do
      if is_descendant "$pane_pid" "$pp"; then pane="$loc"; break; fi
    done < <(tmux list-panes -a -F '#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
    if [ -z "$pane" ]; then
      label="$(fleet_label_for_pid "$pane_pid")"
      if [ -n "$label" ]; then
        if [ "$DRY" = "1" ]; then
          log "dry   $sid  ELIGIBLE — would owner-write /clear to fleet agent $label"
          continue
        fi
        log "FIRE  $sid  /clear → fleet owner-write to $label (all gates held)"
        if fleet_write_clear "$label"; then
          log "sent  $sid  owner-write delivered to $label"
          continue_owner "$label" "$pane_pid"
        else
          log "skip  $sid  owner-write FAILED for $label"
        fi
        continue
      fi
      log "skip  $sid  ELIGIBLE but no tmux pane hosts pid ${pane_pid:-?} and no fleet agent holds it — no writer path"
      continue
    fi
    if [ "$DRY" = "1" ]; then
      log "dry   $sid  ELIGIBLE — would /clear pane $pane"
      continue
    fi
    log "FIRE  $sid  /clear → pane $pane (all gates held)"
    tmux send-keys -t "$pane" C-u
    sleep 0.3
    tmux send-keys -t "$pane" "/clear" Enter
    continue_tmux "$pane" "$pane_pid"
  done
  sleep "$INTERVAL"
done
