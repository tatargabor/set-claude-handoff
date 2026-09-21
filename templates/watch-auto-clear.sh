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
#     AND no fleet agent (ownerd roster, matched by pid) holds it;
#   - PRESENCE GATE (autopilot task 0.2, measured 2026-09-13 10:03:50Z: the watcher's /clear
#     landed inside a half-written human line, and the continue prompt fused with the human's
#     words): before typing ANYTHING, the input line is read (presence.mjs) — only an empty line
#     or a ghost suggestion may be typed into; typed text or an unreadable line skips the pass;
#   - TURN GATE, ONE VERIFIED ESCAPE (turn-state.mjs; measured 2026-09-13 21:24:39Z + 21:26:17Z on
#     consumer-worktree: /clear typed into a seat mid-turn does not execute — it QUEUES; both fires'
#     /clears and continue prompts sat in the queue and the seat worked 25+ min past the limit,
#     while the freshness gate kept passing because one long generation writes nothing to the
#     transcript): a visible spinner line means the turn is running — the executor sends ONE
#     Escape (measured 2026-09-14 probe: it interrupts the turn; a queued message is not
#     submitted, it lands back in the input line), re-verifies spinner-gone + input-line-safe,
#     and only then types. Further Escapes are measured harmful: on an idle empty line one opens
#     a popover that swallows typed input, and with text in the line one CLEARS the text;
#   - FIRE LOCK: the 21:26:17Z fire was the SECOND for a clear still in flight — nothing recorded
#     the first. After typing, the watcher writes {sid, at} to .set/handoff/.firelock-<pid>; a
#     later pass for the SAME sessionId holds until the clear takes effect (the pid's sessionId
#     changes) or 10 minutes pass;
#   - the CONTINUE confirm counts a fragment only inside a USER STRING entry (the 21:25:16Z
#     "CONTINUE confirmed" was false: the old whole-file grep matched "auto-continue" in a
#     skill_listing attachment present from the session's birth; a queued message leaves no user
#     entry, so a user-string hit is the only submitted evidence);
#   - no Ctrl-U before the command: the 10:03:50Z fused prompt carried the Ctrl-U byte literally,
#     so it never cleared the line — the presence + turn gates are what guarantee the line now;
#   - PROVENANCE: every text typed is logged first to <tree>/.set/handoff/typed.jsonl (when the
#     autopilot ledger is installed), so capture hooks never record it as the human's words.
#
# Writers, in order (9.2, measured 2026-09-13: 65 overnight skips of ELIGIBLE sessions whose
# ownerd-held pty no tmux pane hosts):
#   1. tmux send-keys into the pane whose descendant the session pid is;
#   2. OwnerClient.write to the fleet agent whose roster pid matches. Read-only fallback if
#      neither exists: the skip is logged, never silent.
#
# Sessions are matched against EVERY worktree of --dir (9.1, measured: a worktree agent's cwd
# is the worktree, and its handoff dir lives there too — gating it against the main tree
# would read the wrong marker and the wrong handoff).
#
# Usage:
#   watch-auto-clear.sh --dir <projectRoot> [--interval SEC] [--threshold N] [--freshness SEC]
#     [--background-work-blocks true|false] [--started-after ISO] [--gate PATH] [--dry-run]
#     [--auto-continue PROMPT] [--continue-delay SEC] [--autopilot]
#
#   --auto-continue default   use the package's own continue prompt (DEFAULT_CONTINUE below).
#
#   --autopilot   every automatic continuation first runs .claude/hooks/autopilot/drift-guard.mjs
#                 against the FRESH session; without --auto-continue the package's default
#                 continue prompt is used.
#
# Run it under tmux/systemd/nohup — it must outlive the sessions it watches. Runtime state:
#   <root>/.set/handoff/auto-clear.log     one line per verdict
set -u

DIR=""; INTERVAL=60; THRESHOLD=""; FRESHNESS=""; BG="true"; AFTER=""; GATE=""; DRY=0
CONTINUE_PROMPT=""; CONTINUE_DELAY=20; AUTOPILOT=0
DEFAULT_CONTINUE="Autopilot continue after an automatic /clear (auto-continue): read the reloaded handoff file in full. Continue with its CURRENT next step - a later UPDATE section supersedes the original next-steps list, and a step marked done is never redone. Stop and wait only at a decision that the thread's recorded human direction does not already answer - ask it on its own line starting with NEED INPUT: so the keep-going hook lets the stop through."
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
    --autopilot) AUTOPILOT=1; shift;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done
[ -n "$DIR" ] || { echo "--dir is required" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
GATE="${GATE:-$DIR/.claude/hooks/clear-gate.mjs}"
[ -f "$GATE" ] || { echo "gate not found: $GATE" >&2; exit 2; }
PRESENCE="$(dirname "$GATE")/presence.mjs"
[ -f "$PRESENCE" ] || { echo "presence check not found: $PRESENCE — re-run init --auto-clear (typing without it is how the 10:03:50Z collision happened)" >&2; exit 2; }
TURN="$(dirname "$GATE")/turn-state.mjs"
[ -f "$TURN" ] || { echo "turn-state check not found: $TURN — re-run init --auto-clear (typing without it is how the 21:24:39Z queue happened)" >&2; exit 2; }
AP_DIR="$DIR/.claude/hooks/autopilot"
LEDGER="$AP_DIR/ledger.mjs"
DRIFT="$AP_DIR/drift-guard.mjs"
# `--auto-continue default` selects the package's continue prompt without hand-writing one.
[ "$CONTINUE_PROMPT" = "default" ] && CONTINUE_PROMPT="$DEFAULT_CONTINUE"
if [ "$AUTOPILOT" = "1" ]; then
  [ -f "$DRIFT" ] || { echo "--autopilot: drift guard not found: $DRIFT — run init --autopilot" >&2; exit 2; }
  [ -n "$CONTINUE_PROMPT" ] || CONTINUE_PROMPT="$DEFAULT_CONTINUE"
fi

LOG="$DIR/.set/handoff/auto-clear.log"
mkdir -p "$(dirname "$LOG")"
# Parsed with node, not `date -d` (GNU-only): on macOS `date -d` fails, AFTER_MS came back EMPTY
# and the --started-after filter silently turned off — the one filter that keeps a session which
# cannot reload from being cleared. An unparseable value now refuses to start instead.
AFTER_MS=""
if [ -n "$AFTER" ]; then
  AFTER_MS=$(node -e 'const t = Date.parse(process.argv[1]); if (Number.isFinite(t)) process.stdout.write(String(t))' "$AFTER" 2>/dev/null)
  [ -n "$AFTER_MS" ] || { echo "--started-after: cannot parse '$AFTER' as a date" >&2; exit 2; }
fi

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

if ! command -v tmux >/dev/null; then
  if python3 -c "import set_orch.fleet.owner_client" >/dev/null 2>&1; then
    log "tmux not available — the writer path is the fleet owner only"
  else
    echo "tmux not available and the fleet owner client is not importable — no writer path" >&2
    exit 2
  fi
fi
[ -f "$LEDGER" ] || log "note  autopilot ledger not installed — typed text is not provenance-logged"

# Every worktree of DIR is a legitimate session cwd — and each tree gates from ITS OWN
# .set/handoff (9.1). The main tree is first; worktree enumeration failing (plain dir, no
# git) leaves the main tree alone, which is the pre-9.1 behavior.
WORKTREES="$DIR"
while IFS= read -r wt; do
  [ -n "$wt" ] && [ "$wt" != "$DIR" ] && WORKTREES="$WORKTREES
$wt"
done < <(git -C "$DIR" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')

tree_of() { printf '%s\n' "$WORKTREES" | grep -Fx "$1"; }

# Provenance: logged BEFORE typing (specs: intent-ledger). $1 tree, $2 kind, $3 text, $4 session, $5 pid
typed() {
  [ -f "$LEDGER" ] || return 0
  node "$LEDGER" typed --dir "$1/.set/handoff" --kind "$2" --text "$3" --session "$4" --pid "$5" 2>/dev/null \
    || log "warn  typed-log write failed ($2) — capture may record this text as human"
}

# Presence (task 0.2): empty|ghost may be typed into; typed|unknown may not.
safe_to_type() { case "$1" in empty|ghost) return 0;; *) return 1;; esac; }
presence_tmux() { # $1 = pane
  local s; s=$(tmux capture-pane -p -e -t "$1" 2>/dev/null | node "$PRESENCE" 2>/dev/null)
  printf '%s' "${s:-unknown}"
}
presence_owner() { # $1 = fleet label — raw tail bytes, last input-row paint
  local s
  s=$(python3 - "$1" <<'PY' 2>/dev/null | node "$PRESENCE" --stream 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    sys.stdout.write(OwnerClient().tail(sys.argv[1], max_bytes=20000)["data"].decode("utf-8", "replace"))
except Exception:
    pass
PY
)
  printf '%s' "${s:-unknown}"
}

# Turn state (the 21:24:39Z queue): working|queued|idle|unknown — only an idle seat may be cleared.
turn_tmux() { # $1 = pane
  local s; s=$(tmux capture-pane -p -e -t "$1" 2>/dev/null | node "$TURN" 2>/dev/null)
  printf '%s' "${s:-unknown}"
}
turn_owner() { # $1 = fleet label — same patterns against the tail's last window (not fully measured there)
  local s
  s=$(python3 - "$1" <<'PY' 2>/dev/null | node "$TURN" --stream 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    sys.stdout.write(OwnerClient().tail(sys.argv[1], max_bytes=20000)["data"].decode("utf-8", "replace"))
except Exception:
    pass
PY
)
  printf '%s' "${s:-unknown}"
}

# ONE Escape, then re-verify (measured 2026-09-14 probe: one Escape interrupts the running turn;
# a repeat on an idle line opens a popover that swallows typed input, and with text in the line
# it clears the text — so never repeat blindly).
esc_tmux() { tmux send-keys -t "$1" Escape; }
esc_owner() { # $1 = fleet label
  python3 - "$1" <<'PY' 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    OwnerClient().write(sys.argv[1], b"\x1b")
except Exception:
    pass
PY
}
stop_turn() { # $1=turn_fn $2=presence_fn $3=esc_fn $4=target — rc 0 only if the turn is over AND the line is safe
  local state pres
  state=$("$1" "$4")
  case "$state" in
    working|queued) ;;
    idle) return 0;;
    *) return 1;;  # unknown — do not act on an unreadable seat
  esac
  "$3" "$4"
  sleep 2
  state=$("$1" "$4")
  pres=$("$2" "$4")
  safe_to_type "$pres" || return 1
  [ "$state" = "idle" ] || return 1
}

# Fire lock (the 21:26:17Z double fire): held ⇒ a /clear for THIS sessionId is still in flight.
fire_lock_held() { # $1 = tree, $2 = pid, $3 = sid
  local f="$1/.set/handoff/.firelock-$2" state
  state=$(node "$TURN" lock "$f" "$3" 2>/dev/null)
  if [ "$state" = "held" ]; then return 0; fi
  rm -f "$f" 2>/dev/null || true
  return 1
}
fire_lock_write() { # $1 = tree, $2 = pid, $3 = sid
  mkdir -p "$1/.set/handoff"
  printf '{"sid":"%s","at":%s}\n' "$3" "$(( $(date +%s) * 1000 ))" > "$1/.set/handoff/.firelock-$2" 2>/dev/null || true
}

# The fleet-owner writer (9.2): roster lookup by pid.
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

fleet_write() { # $1 = label, $2 = text (no Enter)
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import sys
try:
    from set_orch.fleet.owner_client import OwnerClient
    sys.exit(0 if OwnerClient().write(sys.argv[1], sys.argv[2].encode("utf-8")) else 1)
except Exception:
    sys.exit(1)
PY
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
verify_submitted() { # $1 = pid, $2 = fragment expected in a USER entry of the fresh transcript
  local sid slug
  sid=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$1.json" 2>/dev/null)
  [ -n "$sid" ] || return 1
  slug=$(jq -r '.cwd // empty' "$HOME/.claude/sessions/$1.json" 2>/dev/null | sed 's/\//-/g')
  [ -n "$slug" ] || return 1
  local t="$HOME/.claude/projects/$slug/$sid.jsonl"
  # A whole-file grep confirmed nothing (the 21:25:16Z false confirm matched "auto-continue" in a
  # skill_listing attachment present from birth): only a user STRING entry counts (probe M2 — a
  # queued message leaves no user entry, so a user-string hit is real submission evidence).
  [ -f "$t" ] && node "$TURN" submitted "$t" "$2" 2>/dev/null
}

continue_finish() { # $1 = pid, $2 = where (log label), $3.. = how to press Enter again
  local pid="$1" where="$2" try
  shift 2
  # The fragment comes from the prompt ACTUALLY typed. The fixed "auto-continue" default could
  # never match a custom --auto-continue prompt (measured 2026-09-21 on a consumer seat: a
  # prompt with no such word, a whole-file grep that matched the reinjected handoff instead,
  # a false "confirmed", no Enter retry — the prompt sat unsent until a human pressed Enter).
  # Cut before any quote or backslash: the transcript line is JSON and escapes those.
  local fragment="${CONTINUE_FRAGMENT:-${CONTINUE_PROMPT:0:40}}"
  fragment="${fragment%%[\"\\]*}"
  [ -n "$fragment" ] || fragment="auto-continue"
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

# The continuation gate: the FRESH session id (the runtime record rewrites it on a clear) and,
# under --autopilot, the drift guard's verdict for it (specs: drift-guard). Prints the fresh id.
continue_gate() { # $1 = pid, $2 = the cleared session id, $3 = tree
  local fresh verdict
  fresh=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$1.json" 2>/dev/null)
  if [ -z "$fresh" ] || [ "$fresh" = "$2" ]; then
    log "CONTINUE held  no fresh session id on pid $1 after the clear of $2"
    return 1
  fi
  if [ "$AUTOPILOT" = "1" ]; then
    verdict=$(node "$DRIFT" --session "$fresh" --cwd "$3" --json 2>/dev/null)
    if [ "$(printf '%s' "$verdict" | jq -r '.continue // false' 2>/dev/null)" != "true" ]; then
      log "CONTINUE held  drift guard: $(printf '%s' "$verdict" | jq -r '[.checks[]? | select(.ok == false) | .name + ": " + .detail] | join("; ")' 2>/dev/null)  (fresh $fresh)"
      return 1
    fi
    log "CONTINUE drift guard passed  (fresh $fresh)"
  fi
  printf '%s' "$fresh"
}

continue_tmux() { # $1 = pane, $2 = pid, $3 = cleared sid, $4 = tree
  [ -n "$CONTINUE_PROMPT" ] || return 0
  sleep "$CONTINUE_DELAY"
  local fresh state
  fresh=$(continue_gate "$2" "$3" "$4") || return 0
  state=$(presence_tmux "$1")
  safe_to_type "$state" || { log "CONTINUE held  presence=$state in pane $1 — a human is at the keyboard"; return 0; }
  typed "$4" continue "$CONTINUE_PROMPT" "$fresh" "$2"
  tmux send-keys -t "$1" -l "$CONTINUE_PROMPT"
  sleep 1.5
  tmux send-keys -t "$1" Enter
  log "CONTINUE sent  auto-continue prompt → pane $1"
  continue_finish "$2" "pane $1" tmux send-keys -t "$1" Enter
}
continue_owner() { # $1 = fleet label, $2 = pid, $3 = cleared sid, $4 = tree
  [ -n "$CONTINUE_PROMPT" ] || return 0
  sleep "$CONTINUE_DELAY"
  local fresh state
  fresh=$(continue_gate "$2" "$3" "$4") || return 0
  state=$(presence_owner "$1")
  safe_to_type "$state" || { log "CONTINUE held  presence=$state on fleet agent $1 — a human is at the keyboard"; return 0; }
  typed "$4" continue "$CONTINUE_PROMPT" "$fresh" "$2"
  fleet_write "$1" "$CONTINUE_PROMPT" || { log "CONTINUE FAILED  owner-write of the prompt to $1"; return 0; }
  sleep 1.5
  fleet_owner_enter "$1"
  log "CONTINUE sent  auto-continue prompt → fleet agent $1"
  continue_finish "$2" "fleet agent $1" fleet_owner_enter "$1"
}

# Is pid $1 a descendant of tmux pane pid $2? Walks the parent chain with `ps`, which Linux and
# macOS both have — /proc does not exist on macOS, so a /proc walk found no pane there at all.
is_descendant() {
  local p="$1" want="$2"
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    [ "$p" = "$want" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}

log "watcher started dir=$DIR interval=${INTERVAL}s threshold=${THRESHOLD:-default} bg-blocks=$BG started-after=${AFTER:-any} dry-run=$DRY auto-continue=$([ -n "$CONTINUE_PROMPT" ] && echo on || echo off) autopilot=$([ "$AUTOPILOT" = "1" ] && echo on || echo off)"
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
        state=$(presence_owner "$label")
        if ! safe_to_type "$state"; then
          log "skip  $sid  ELIGIBLE but presence=$state on fleet agent $label — a human may be typing; not typing this pass"
          continue
        fi
        if fire_lock_held "$tree" "$pane_pid" "$sid"; then
          log "skip  $sid  fire lock: a previous /clear is still in flight on pid $pane_pid — not re-firing"
          continue
        fi
        if ! stop_turn turn_owner presence_owner esc_owner "$label"; then
          log "skip  $sid  turn=$(turn_owner "$label") presence=$(presence_owner "$label") on fleet agent $label after one Escape — not typing this pass"
          continue
        fi
        if [ "$DRY" = "1" ]; then
          log "dry   $sid  ELIGIBLE (presence ok, turn stopped) — would owner-write /clear to fleet agent $label"
          continue
        fi
        log "FIRE  $sid  /clear → fleet owner-write to $label (all gates held, presence ok, turn stopped)"
        typed "$tree" clear "/clear" "$sid" "$pane_pid"
        fire_lock_write "$tree" "$pane_pid" "$sid"
        if fleet_write "$label" "/clear"; then
          sleep 0.3
          fleet_owner_enter "$label"
          log "sent  $sid  owner-write delivered to $label"
          continue_owner "$label" "$pane_pid" "$sid" "$tree"
        else
          log "skip  $sid  owner-write FAILED for $label"
        fi
        continue
      fi
      log "skip  $sid  ELIGIBLE but no tmux pane hosts pid ${pane_pid:-?} and no fleet agent holds it — no writer path"
      continue
    fi
    state=$(presence_tmux "$pane")
    if ! safe_to_type "$state"; then
      log "skip  $sid  ELIGIBLE but presence=$state in pane $pane — a human may be typing; not typing this pass"
      continue
    fi
    if fire_lock_held "$tree" "$pane_pid" "$sid"; then
      log "skip  $sid  fire lock: a previous /clear is still in flight on pid $pane_pid — not re-firing"
      continue
    fi
    if ! stop_turn turn_tmux presence_tmux esc_tmux "$pane"; then
      log "skip  $sid  turn=$(turn_tmux "$pane") presence=$(presence_tmux "$pane") in pane $pane after one Escape — not typing this pass"
      continue
    fi
    if [ "$DRY" = "1" ]; then
      log "dry   $sid  ELIGIBLE (presence ok, turn stopped) — would /clear pane $pane"
      continue
    fi
    log "FIRE  $sid  /clear → pane $pane (all gates held, presence ok, turn stopped)"
    typed "$tree" clear "/clear" "$sid" "$pane_pid"
    fire_lock_write "$tree" "$pane_pid" "$sid"
    tmux send-keys -t "$pane" -l "/clear"
    sleep 0.3
    tmux send-keys -t "$pane" Enter
    continue_tmux "$pane" "$pane_pid" "$sid" "$tree"
  done
  sleep "$INTERVAL"
done
