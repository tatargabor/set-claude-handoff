#!/usr/bin/env bash
# statusline-persist — one fragment for the project's statusline script.
#
# WHAT: persist the documented live context number every time the statusline renders, so the
# clear-gate (templates/clear-gate.mjs) reads a documented value instead of parsing the
# transcript (whose format is officially unstable).
#
# The statusline stdin JSON carries `context_window.total_input_tokens` — "token counts
# currently in the context window, from the most recent API response". Numbers from a render
# older than the freshness bound are treated as UNKNOWN by the gate (unknown is never
# above-threshold), so a session that has been idle for a long time is simply not armed from
# this file alone — the gate then falls back to the transcript's last usage triple.
#
# INSTALL (manual merge — your statusline is YOURS, init never touches it):
#   source this block near the top of ~/.claude/statusline.sh (or a project statusline),
#   or paste the three command lines. It must not slow the render: one jq, one atomic mv.
#
#   session8=$(printf '%s' "$session_id" | tr -cd 'a-zA-Z0-9' | cut -c1-8)
#   tokens_file="${CLAUDE_PROJECT_DIR:-$PWD}/.set/handoff/.context-tokens${session8:+-$session8}"
#   total_input=$(printf '%s' "$input" | jq -r '.context_window.total_input_tokens // empty')
#   [ -n "$total_input" ] && printf '{"totalInputTokens":%s,"updatedAt":"%s"}\n' \
#     "$total_input" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tokens_file.tmp" 2>/dev/null \
#     && mkdir -p "$(dirname "$tokens_file")" && mv "$tokens_file.tmp" "$tokens_file"
#
# NOTE: `$input` is the statusline's stdin JSON variable, as in your existing script.
# NOTE (9.3, 2026-09-13): the file is PER-SESSION — `.context-tokens-<first8ofsessionid>` —
# because the shared name let two sessions in one repo overwrite each other's numbers
# (measured in the armed consumer night: session B read session A's 474k+ as its own).
# The gate reads the per-session file first; the shared name is only read when the stdin
# carries no session id. Keep `$session_id` (`.session_id` from the same stdin JSON).
# NOTE: the null/zero window right after a /clear is handled by the gate, not here: it reads
# this file together with its timestamp, and treats stale or unknown as not-eligible.
