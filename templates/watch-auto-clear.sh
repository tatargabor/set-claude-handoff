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
#   - a session not hosted by any tmux pane is skipped with a logged reason (no writer path).
#
# Usage:
#   watch-auto-clear.sh --dir <projectRoot> [--interval SEC] [--threshold N] [--freshness SEC]
#     [--background-work-blocks true|false] [--started-after ISO] [--gate PATH] [--dry-run]
#
# Run it under tmux/systemd/nohup — it must outlive the sessions it watches. Runtime state:
#   <root>/.set/handoff/auto-clear.log     one line per verdict
set -u

DIR=""; INTERVAL=60; THRESHOLD=""; FRESHNESS=""; BG="true"; AFTER=""; GATE=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --threshold) THRESHOLD="$2"; shift 2;;
    --freshness) FRESHNESS="$2"; shift 2;;
    --background-work-blocks) BG="$2"; shift 2;;
    --started-after) AFTER="$2"; shift 2;;
    --gate) GATE="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done
[ -n "$DIR" ] || { echo "--dir is required" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
GATE="${GATE:-$DIR/.claude/hooks/clear-gate.mjs}"
[ -f "$GATE" ] || { echo "gate not found: $GATE" >&2; exit 2; }
command -v tmux >/dev/null || { echo "tmux not available — no writer path" >&2; exit 2; }

LOG="$DIR/.set/handoff/auto-clear.log"
mkdir -p "$(dirname "$LOG")"
AFTER_MS=""; [ -n "$AFTER" ] && AFTER_MS=$(date -d "$AFTER" +%s%3N 2>/dev/null)

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Is pid $1 a descendant of tmux pane pid $2? Walks the /proc parent chain.
is_descendant() {
  local p="$1" want="$2"
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    [ "$p" = "$want" ] && return 0
    p=$(sed -E 's/^[0-9]+ \([^)]*\) //' "/proc/$p/stat" 2>/dev/null | awk '{print $2}')
  done
  return 1
}

log "watcher started dir=$DIR interval=${INTERVAL}s threshold=${THRESHOLD:-default} bg-blocks=$BG started-after=${AFTER:-any} dry-run=$DRY"
while :; do
  for rec in "$HOME"/.claude/sessions/*.json; do
    [ -f "$rec" ] || continue
    sid=$(jq -r '.sessionId // empty' "$rec" 2>/dev/null) || continue
    cwd=$(jq -r '.cwd // empty' "$rec" 2>/dev/null)
    [ "$cwd" = "$DIR" ] || continue
    [ -n "$sid" ] || continue
    if [ -n "$AFTER_MS" ]; then
      started=$(jq -r '.startedAt // 0' "$rec" 2>/dev/null)
      [ "${started:-0}" -ge "$AFTER_MS" ] 2>/dev/null || { log "skip  $sid  started before --started-after"; continue; }
    fi
    slug=$(printf '%s' "$cwd" | sed 's/\//-/g')
    transcript="$HOME/.claude/projects/$slug/$sid.jsonl"
    gate_args=(--session "$sid" --transcript "$transcript" --dir "$DIR/.set/handoff" --json --background-work-blocks "$BG")
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
      log "skip  $sid  ELIGIBLE but no tmux pane hosts pid ${pane_pid:-?} — no writer path"
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
  done
  sleep "$INTERVAL"
done
