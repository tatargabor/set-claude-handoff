# Investigation: automatic `/clear` at the soft context limit, with automatic handoff reload

**Date:** 2026-09-12 · **Requested by:** dictation (the user) · **Scope:** investigation only — no implementation.
**Trigger request:** a feature that lets the Claude Code terminal itself execute `/clear` when (a) the context
is large enough (~500k tokens), (b) the handoff is already collected, (c) no active task is running — and
after the `/clear`, automatically reloads the handoff. Motivation: unattended night sessions currently hit the
soft limit and get **auto-compacted**, which loses the measured detail; there is no guarantee a cleared
session reloads the handoff.

---

## 1. Verification requested first: which project, which skill

- This session runs in `~/code/set-claude-handoff` (main @ `a02fe2a`, clean tree aside from untracked
  `.claude/` openspec tooling and `openspec/`).
- The skill consumer-repo actually uses is the **globally installed** `~/.claude/skills/handoff` (a real directory,
  not a symlink) plus the project-owned `consumer-repo/.claude/handoff.profile.md` (13.7 kB, updated today).

⚠ **Standalone finding — the installed skill is AHEAD of the repo.** `~/.claude/skills/handoff/SKILL.md`
contains Phase 1b (other carriers: memory / scratch / background), the scratch-rescue rule, Phase 4b (fleet
focus announcement), §7 (method learnings) and *four* skeleton rules — none of which exist in
`set-claude-handoff/skills/handoff/SKILL.md` @ main. Consumers run the newer text. **Until this is synced
back, the next `init` from the repo would downgrade every consumer.** Syncing it back is a separate, cheap,
high-value task.

## 2. What already exists (all measured, in production in consumer-repo)

| piece | event / place | what it proves |
|---|---|---|
| `scripts/hooks/context-guard.mjs` | PreToolUse / PostToolUse | context size is reliably measurable from the transcript: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (cache_read is the dominant term: 334 900 of 338 009 measured). SOFT = 500 000 (user decision 2026-08-26; a 480k firing once left only ~7k tokens of slack, hence 500k), HARD denies further tool calls. Every measurement logged to `.claude/logs/context-guard.jsonl`. |
| global `settings.json` | `~/.claude/settings.json` | `autoCompactWindow: 600000`, `autoCompactEnabled: true`, model `opus[1m]` — so the soft target is 500k, compaction currently fires at 600k. |
| `scripts/hooks/handoff-auto.mjs` | PreCompact | the machine-written state page (branch, commits, dirty files, round state, parked questions) exists, but **cannot write intent, decisions, or the "why"** — by design. |
| `scripts/hooks/handoff-reinject.mjs` | SessionStart, matcher `compact` | **content reinjection after compact works and has worked for years** (`compact-reinject.sh` before it). Measured 2026-08-25: the PreCompact `customInstructions` path is dead (four field shapes, 0 hits); the SessionStart `additionalContext` path works. Caps: 16k chars manual + 8k chars machine (~6–7k tokens). Idempotent per session via `.injected-<session8>` marker. Since 2026-09-05 it injects the latest manual handoff's **content** (mtime heuristic, others named) — before that it only *named* the file and the post-compact session did not read it. |
| `scripts/hooks/handoff-write-check.mjs` | PostToolUse (Write/Edit) | deterministic content gate on `.set/handoff/*.md` at write time; already receives `session_id` in the hook payload. |
| `scripts/handoff-resolve.mjs --auto` | profile convention | an empty `/handoff` in a fresh context (≤ 4 assistant turns) proposes **loading** the latest handoff; in a working session it says **write**. Session identity from `CLAUDE_CODE_SESSION_ID`, deliberately not "newest transcript" (parallel sessions). |
| `skills/handoff/SKILL.md` Phase 4 | package | ends every handoff with "Ready for /clear" and states the current contract: *"`/clear` is issued **by the user**, not by you — no session has a tool to erase its own context."* |
| `~/.claude/sessions/<pid>.json` | runtime | one live record per session: `pid, sessionId, cwd, status ("busy" / "waiting"), waitingFor, messagingSocketPath, version` (fleet discovery measured 23/23 records↔processes, nothing stale). |
| set-core fleet | `code2/set-core` | `fleet/owner.py` **holds the pty of every agent the fleet started and can write into it** (writes into foreign terminals are refused); `fleet/instruct.py` carries instructions to everything else **on the bus**, because **`dev.tty.legacy_tiocsti = 0` on this machine** — typing into a foreign terminal is a system boundary, not an obstacle; `fleet/context_fill.py` already resolves per-agent context fill; roster + discovery already enumerate live sessions per project. |
| set-copilot | `code/set-copilot` | session-scoped sidecar pattern exists (`SET_COPILOT_DIR` with per-session PID files) — the natural host for a per-session watcher, and it has **no** watcher command today. |

## 3. The gap

Today's night chain: 500k → SOFT prose warning (the model *should* write `/handoff`; prose mandates are
measured to lag — the §2a rate went 9% → 54% and stalled) → 600k → **auto-compact** (loses the measured
detail; only the reinjected pages survive) → SessionStart(compact) reload. Two things are missing:

1. **No trigger executes `/clear`** — the skill contract explicitly forbids the session from erasing its own
   context, and nothing outside does it either.
2. **No reload after `/clear`** — `handoff-reinject` matches only `compact`. After a `/clear` the fresh
   context reloads *only if* someone runs `/handoff` (which `--auto` then resolves). Nothing tells it to.
   This is the "no sure that the clear session will reload the handoff" problem.

## 4. Prior decisions on record

- **2026-09-01, night demo round plan** (`consumer-repo/docs/planning/2026-09-01-ejszakai-demo-kor-terv.md`):
  for *orchestrated night rounds* the answer was architectural — don't manage a controller's context,
  **avoid the long-lived controller context** (apply-cycle pattern: every section in its own `claude -p`
  with fresh context). That decision covers controllers; it does not cover a long-lived **interactive**
  session left alone at night — which is exactly this request.
- **2026-09-05 (the user):** the compact path already reinjects handoff *content* ("ezért kell compact utáni
  hook-ba is hogy tltse vissza automatan"). The auto-reload principle is therefore **already accepted** for
  compact; extending it to `/clear` is a continuation of that decision, not a reversal of it.
- The "skip auto reload" decision the dictation remembers is the pre-2026-09-05 state (reinject only
  *named* the manual handoff) plus the 09-01 no-controller-context stance. Both are superseded or scoped;
  reconsideration is warranted and the layer where it now works is proven.

## 5. The feature, assembled from proven parts

**Gates (all deterministic):**

1. **context ≥ 500k** — the *documented* live source is the statusline JSON:
   `context_window.total_input_tokens` (= input + cache_creation + cache_read of the last API response —
   the same formula context-guard measures from the transcript, which is officially unsupported: the
   transcript format "changes between versions"). Practical shape: the existing `statusline.sh` already
   receives `context_window` every render — let it persist `total_input_tokens` to a file any hook or
   watcher can read, and the fragile transcript parsing becomes the fallback, not the source. Threshold
   already a decided, measured number (2026-08-26). No new decision needed.
2. **handoff already collected, for THIS session** — stronger than a transcript regex: have the existing
   `handoff-write-check.mjs` PostToolUse hook drop a per-session marker
   (`.set/handoff/.written-<session8>`) when a handoff file passes the gate. The hook already sees
   `session_id` and the file path; the marker's mtime gives freshness (must postdate the session start /
   last clear). A regex on the transcript is the weaker cousin of a gate that already exists — and the
   skill's own confirmation line ("Ready for /clear") is prose, not a gate.
3. **no active task** — the runtime record's `status` ("busy" vs "waiting") plus transcript tail with no
   pending `tool_use`; additionally require **no pending permission prompt** (a queued permission request
   means the human is expected — clearing there would discard it). Background processes, monitors, cron and
   workflows surviving the clear is the user's stated, correct assumption (the profile's "Figyelők és
   cron-ok" section documents the same for compact: the *knowledge* that they run is what needs carrying,
   and the handoff's §4 already carries it).

**Trigger — `/clear` must come from outside the session (no self-erase tool — and docs agree: "Command
hooks… can't trigger `/` commands or tool calls", and a hook process "can't open `/dev/tty`"). The options,
strongest first:**

- **(a) Remote Control — the only *documented* external `/clear`.** A connected Remote Control client
  (claude.ai / mobile) can run `/clear` in the live local session ("When you run `/clear`, the conversation
  resets on connected devices too"). If the fleet could act as a Remote Control client, the trigger would be
  fully supported end-to-end; whether a *headless programmatic* RC client is possible is undocumented —
  worth a probe, it would make the whole feature official.
- **(b) Fleet-owned sessions:** `fleet/owner.py` already holds the pty and can write into it. A
  `clear-armed` decision + pty write of `/clear` + Enter is a small extension of an existing capability.
- **(c) Sessions under tmux:** `tmux send-keys` works — tmux is the pane's pty master, so the
  `legacy_tiocsti=0` boundary does not apply. Undocumented but mechanically sound; the writer must be an
  external process (a hook cannot open a tty itself, but it may spawn one — `async: true` — or the watcher
  is external anyway).
- **(d) Plain foreign terminal: impossible by system boundary.** `dev.tty.legacy_tiocsti = 0` refuses the
  injection, and `instruct.py` records this as deliberate. A night session in a bare terminal cannot be
  `/clear`-ed from outside — it must run under (a), (b) or (c).
- **(e) The per-session messaging socket** (`/run/user/1000/cc-socks/<pid>.sock`, peer features include
  `notify_idle`) and Channels reach the *model*, which still cannot clear itself — so they are not
  triggers, but they are the right channel for the pre-handoff nudge ("finish the thread, write the
  handoff").

**Executor shape:** a small watcher that enumerates `~/.claude/sessions/*.json` (or reuses fleet roster +
context fill), applies the three gates, and fires the trigger. The set-copilot sidecar pattern
(`SET_COPILOT_DIR` PID files) or the fleet owner process are both natural hosts; a standalone systemd user
unit also works. It must be per-session safe by construction (parallel sessions on one tree are the norm in
consumer-repo).

**Reload after `/clear`:** documented, not just observed — `SessionStart` fires with source `clear` after
every `/clear` (after `SessionEnd` reason `clear`), hooks run in the background while the prompt re-opens,
and Claude's first response waits for them; context arrives via stdout or `additionalContext`. Note `/clear`
starts a **new session in the same process** (the old conversation stays on disk and resumeable) — so the
reload hook sees a *new* `session_id` (fresh idempotency marker, `--auto`'s ≤4-turns logic applies), while
the handoff to load was written by the *previous* session: newest-file/`.latest` resolution covers that, the
*trigger* gate stays per-session. Docs cap hook output at **10 000 characters** — over the cap the content
is saved to a file and Claude gets path + preview, so the safe shape is: inject pointer + preview up to the
cap, and let the fresh context `Read` the full handoff file (consumer-repo's 16k manual cap already silently
relies on the overflow-to-file behavior). The reload then runs for **every** `/clear`, manual or automatic —
which is what makes the automation safe: a human typing `/clear` gets the same reload.

**Backstop:** keep auto-compact at 600k + `handoff-auto` exactly as today. If the watcher or trigger fails
at night, the session compacts and still reinjects — degradation is one step, not a wedge. Docs confirm a
PreCompact hook *can* block compaction (exit 2 / `decision: block`), with a sharp caveat: blocking is
reliable only for the **proactive** auto-compact; if compaction is already the recovery for a context-limit
error, blocking surfaces the API error and **the request fails**. So the inverse option (block PreCompact
when a fresh session-owned handoff exists, to force the clear path) is viable but must never apply near the
hard limit — and with auto-compact merely *disabled*, the documented failure is the "prompt too long" error,
not a forced compact. Either way the watcher — not the block — has to be the primary mechanism. Not
recommended for v1.

**Division of labor (package vs project vs fleet):** principle 1 of this package — nothing project-specific
in `SKILL.md`. The generic parts (marker convention, `SessionStart(clear)` reinject template, the gate
checklist) belong in **set-claude-handoff**, thresholds and paths in the **profile**, and the trigger
executor (pty write / tmux wrapper) is **environment**-specific — fleet or a sidecar, wired by `init` as an
opt-in. The skill text itself only changes in one place: Phase 4's "issued by the user" contract gains the
documented exception ("or by the session's own automation, when the gates hold").

## 6. Risks and open questions

1. **Pending permission prompts** at the moment of clearing — must be a gate, not an afterthought.
2. **Parallel sessions on one tree** — `.latest` is repo-global; the mtime heuristic can pick another
   thread's handoff. The existing mitigations (named alternatives, "verify it's yours") carry over, but the
   *trigger* must be strictly per-session (marker + session record), never "someone wrote a handoff".
3. **Async Stop hooks** (`stop-verify`, 900 s typecheck+suite) — "idle" must mean "turn ended", and the
   watcher should not clear while an async verification is still writing its result into the transcript.
4. **The model handoff must exist before 500k.** At night nobody types it. Chain: SOFT warning →
   (optionally) a bounded Stop-hook nudge in the recovery-guard style (MAX_NUDGES) → marker gate blocks the
   clear until the handoff passes the write-check. If the model never writes it, the clear never fires and
   compact catches at 600k — the backstop ordering makes every failure mode land somewhere soft.
5. **Verified by docs, still worth one live pilot on 2.1.269:** `SessionStart source: clear` firing and
   injecting (documented; consumer-repo only ever matched `compact` in practice); the 10 000-char cap and
   overflow-to-file behavior; statusline `context_window` numbers being null right after a clear (the
   watcher must not read a stale/zero value as "small context" — its own last-persisted value guards this).
6. **⚠ The user's survival assumption is unverified:** that background tasks, monitors, workflows and
   external processes survive `/clear`. External processes obviously do; but for harness-tracked background
   tasks **the docs are silent** — the neighboring facts point both ways (on `/branch`, in-flight background
   work keeps running — registries are process-scoped; across a process resume they are not restored).
   `/clear` starts a new session in the same process, so survival is *plausible*, but this must be an
   empirical test on 2.1.269 **before** the gate treats "background work exists" as non-blocking. If it
   turns out they are dropped, the gate needs a "no unfinished background work" condition instead.

## 7. Suggested next step (when this leaves "investigate only")

Pilot in consumer-repo, not in the package first: (1) sync the installed skill back to the repo; (2) add the
`.written-<session8>` marker to `handoff-write-check.mjs`; (3) generalize `handoff-reinject.mjs` to the
`clear` matcher and live-verify it fires; (4) run one night session under tmux or the fleet owner with a
watcher in dry-run logging mode, then arm it. Draft as an OpenSpec change in consumer-repo; promote the generic
pieces into the package once the pilot measures clean.

---

## Appendix: doc-side verification (Claude Code capabilities)

Local build: **2.1.269** — every version-gated mechanism below (≥2.1.221 `/autocompact`, ≥2.1.251
`context_tokens`, the `/clear`-resets-remotes behavior) is present on this machine. Sources:
code.claude.com/docs/en — hooks, hooks-guide, cli-reference, remote-control, channels, statusline,
settings-reference, model-config, commands, sessions, interactive-mode, context-window, errors.

**A1. Can anything run `/clear` in a live session from outside?**
Hooks: no — "Command hooks communicate through stdout, stderr, and exit codes only. They can't trigger
`/` commands or tool calls"; a hook process "can't open `/dev/tty`" (only allowlisted OSC notification
sequences are permitted). CLI: no `--send-message`; `-p` is a new process; `--resume`/`--continue` load a
saved transcript into a new invocation, never proxy into a live one. Officially supported remote paths:
**Remote Control** — documented to run `/clear`, `/compact`, `/context`, `/usage`, `/exit` in the live
local session from claude.ai/mobile; **Channels** (research preview) — pushes events the model *reads*,
docs silent on slash commands. tmux send-keys: undocumented workaround. A Stop hook's
`{"decision":"block"}` forces the conversation to continue (capped at 8 consecutive blocks) — it can make
the model *finish and write the handoff*, never clear.

**A2. PreCompact blocking.** Matchers `manual` / `auto`; input carries `trigger` and
`custom_instructions`. "Can block? Yes — Blocks compaction" (exit 2 or `decision: block`). Reliability
caveat, verbatim: proactive compaction is skipped cleanly; if compaction was recovering an already-returned
context-limit error, "the underlying error surfaces and the current request fails."

**A3. SessionStart after `/clear`.** Sources: `startup`, `resume`, `clear`, `compact`, `fork`. After
`/clear`: `SessionEnd(reason: clear)` → hooks run in background → `SessionStart(source: clear)`; the
prompt re-opens immediately but Claude's first response waits for the hooks; a second `/clear` while they
run cancels them. Injection: exit-0 stdout or `hookSpecificOutput.additionalContext`, placed before the
first prompt. **Cap: 10 000 characters** on hook output strings; overflow is written to a file in the
session directory and Claude receives path + preview. `sessionTitle` is ignored on `clear`/`compact`;
`mcp_tool` SessionStart hooks are skipped at launch but do run after `/clear`.

**A4. Measuring live context.** Hook inputs carry **no token counts** (exceptions: SessionStart
`resume`/`fork` and Pre/PostModelSwitch get `context_tokens`). The statusline JSON is the documented live
source: `context_window.total_input_tokens` ("token counts currently in the context window, from the most
recent API response"), `context_window_size`, `used_percentage`, `current_usage.*`, `exceeds_200k_tokens`.
Documented identity: used = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (input
only). Null before the first API call and again after `/compact` until the next call. Transcript JSONL: the
format "is internal to Claude Code and changes between versions" — parsing it is unsupported (consumer-repo's
context-guard does exactly this and works, but it is a breakable-on-any-release dependency).

**A5. Settings.** `autoCompactEnabled` and `autoCompactWindow` are both documented settings keys ("Turn
automatic compaction off or on" / "Set how full the context gets before Claude Code compacts"). Window
range 100k–1M; precedence env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` > `--autocompact` flag > saved setting
(written by `/autocompact`, 2.1.221+); `DISABLE_COMPACT` disables all compaction. With auto-compact **off**
the documented failure is the 200k/context-limit error ("Prompt is too long") — no forced compact is
documented at 100%. This machine pins `autoCompactWindow: 600000`, `autoCompactEnabled: true`.

**A6. What `/clear` keeps and kills.** Starts a **new session in the same process**; the previous
conversation is saved and recoverable (`/resume`, rewind menu). Keeps: process-level state — settings,
command history, **MCP connections** ("SessionStart fires again with the servers already available"),
CLAUDE.md re-loads for the new session. Resets: the conversation. Fires: `SessionEnd(clear)` then
`SessionStart(clear)`. **Background bash tasks / monitors / workflows across `/clear`: docs are silent.**
Adjacent documented facts: background tasks are cleaned up on process *exit*; on `/branch` (same process)
in-flight background work keeps running; across a process resume it is not restored. Empirical test on
2.1.269 required before the feature relies on survival.
