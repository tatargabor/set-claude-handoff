# Investigation: keeping an auto-continued thread on course, and answering its questions from the human's own words

**Date:** 2026-09-13 · **Requested by:** dictation (the user) · **Scope:** investigation, then a change proposal.
**Build measured:** Claude Code 2.1.270 (`claude --version`).

**Trigger request (dictated, summarized):** the auto-clear cycle (limit → handoff → clear → reload →
continue) now runs unattended. Two more mechanisms are needed, and they are linked:

1. **Drift guard** — after several automatic handoff + clear cycles the knowledge must not thin out
   until the agent works on something else entirely. A session is created with a direction (a bugfix
   session stays a bugfix session; a feature session stays on that feature until it is done).
2. **Auto-answer** — when the agent stops (an `AskUserQuestion`, a prose question, or "done, what
   next?"), and the answer is **certainly** derivable from what the human already said in that session
   (typed, dictated, via copilot), the machinery answers and the work continues — instead of waiting.
   Prose instructions alone were measured not to prevent the stop. The user asked which mechanism fits:
   a separate watcher, a hook, or something else.

---

## 1. What exists today

| piece | where | relevance |
|---|---|---|
| auto-clear cycle | `templates/{clear-gate.mjs,watch-auto-clear.sh,hooks/handoff-reinject-clear.mjs}` | armed on the consumer since 2026-09-12; 4 FIREs in `auto-clear.log`, 2 with auto-continue |
| auto-continue prompt | consumer watcher args | *„…folytasd a munkát a §5 (Következő lépések) első nyitott pontján. Ha a folytatás §3-as felhasználói döntésbe ütközik, ott állj meg…"* — **the only thread anchor across a clear** |
| question routing (Discord) | private-copilot `scripts/consumer-kerdes.mjs`, `scripts/kerdes-stop-or.mjs`; consumer `scripts/kerdes-eszkalacio.mjs`, skill `kerdes` | still wired; the return path (`consumer-valasz-poll.timer`) disabled since the 2026-09-11 system pause — questions go out, answers do not come back |
| Stop-hook question guard | `kerdes-stop-or.mjs` | blocks a turn ending in a question **only in away mode**; its reason text already offers *„vezesd le a döntést… mondd ki a feltevésedet írásban, és haladj vele"* |
| project goals | consumer `docs/celok/aktiv-celok.yaml`, printed at SessionStart | project-wide, not per thread |
| per-session intent | — | **nothing records it** (swept: set-copilot, private-copilot, set-core, consumer) |

⚠ **Prior decision this request revises** — consumer `docs/planning/2026-08-17-kerdes-mechanizmus-rendszerterv.md`
§2.3: *„Nincs olyan ág, ahol az őr a felhasználó helyett DÖNT vagy a kérdést feladottnak jelöli — blokkol,
de soha nem állít."* Today's dictation asks for exactly such a branch, restricted to answers that are
certainly derivable. The change must name this revision and keep its restriction structural, not prose.

## 2. Measured: what happened in the real auto-continued cycles

Sweep of the consumer's `auto-clear.log` and 245 transcripts (7 days, main + worktree slugs, sidechains
excluded). Fresh session ids matched to FIREs by the millisecond-exact `/clear` entry.

| FIRE (UTC) | old → fresh | auto-continue | what happened |
|---|---|---|---|
| 08:46:52 | `9adce541` → `7ffc9ebc` | off | reinject loaded **another worktree's handoff** (`0912-ff48`, by mtime); human bridged with `/handoff 0912-a16a` after 4 min 59 s |
| 09:25:13 | `9e94a4ee` → `4aa5b19b` | off | before any human input, a bus message made it **hand its own thread to another seat**; human corrected 39 s later |
| 09:41:13 | `7ffc9ebc` → `cf14d717` | on | Enter swallowed, submitted 4 min late (fixed in `b292532`); then worked §5 step 1 — on course; asked a **non-§3** question and waited 23 min 24 s |
| 10:03:50 | `4aa5b19b` → `b955a632` | on | on course — **but see §3: the watcher typed into the human's half-written line** |

**Drift, measured:** no realized drift in the two auto-continued sessions (n = 2, human present in both —
unattended behavior was not observed). **Two near-drifts** in the same morning, both of the kind the
auto-continue prompt would have amplified: the wrong-tree reload, and the thread given away on the bus.
**A third, structural one:** `0912-ff48`'s §5 steps 1–3 were already done per its own UPDATE block — the
auto-continue prompt, taken literally ("§5 first open step"), would redo committed work. The session
followed the UPDATE block; the prompt did not make it do so.

**Stops, measured (7 days):**

- 38 `AskUserQuestion` calls; 64 questions answered: **41 picked the "(Recommended)" option**, 17 another
  listed option, 6 free text; 5 rejected.
- 782 text-ended assistant turns; 73 with a choice phrase, 41 ending in `?`. Median wait for the human's
  reply after a `?`: **308 s**. Waits > 1 h: 16 after plain statements.
- **Longest avoidable stop: 9 h 43 min** (`9e94a4ee`, 23:33 → 09:16) — while at 21:47 the human had
  written *„elmentem aludni amit tudsz csinald meg, vagy nyomozd ki"*.
- 25-pair sample (hand-picked for variety, not random): **7 DERIVABLE** (5 with an earlier verbatim human
  quote, 2 from session state only), **9 APPROVAL-ONLY** (4 of them accepted prompt suggestions),
  **9 NEW-DECISION**. Example of DERIVABLE: `4aa5b19b` 09:29 asked whether to continue the resolver
  fixes — the human had said *„igen, javítsd a resolver három hibáját, GLM-en teszteld"* at 09:16.

What this establishes: avoidable stops are real and a meaningful share (~⅓ of the sample) is answerable
from a verbatim earlier quote; ~⅓ is genuinely new and must never be answered by a machine. What it
cannot establish: the true rate (sample not random), unattended behavior, or how many prose questions the
regex missed.

## 3. Measured defect in the ARMED executor (separate from this request)

At the 10:03:50 FIRE the human was typing in that pane. Their saved message ends *„…we don1t need
opu/clear"* — **the watcher's `/clear` was typed into the half-written line**. The auto-continue prompt
was then submitted as `"glm is jo lehet\x15Folytatás automatikus /clear után…"`: the human's words and
the machine prompt fused into one message, with **the Ctrl-U byte recorded literally** — on the fleet
owner-write path it does not kill the input line. The idle gate reads the transcript; a human typing
without submitting leaves no trace there. **The executor needs a human-presence gate (non-empty input
line / recent keystrokes ⇒ skip this pass) and must not rely on Ctrl-U.** This belongs to
`auto-clear-with-handoff-reload` as a follow-up task, not to the new change.

## 4. Provenance — why the record of human input cannot be read back from the transcript

Measured field map (7 days):

| entry | how it looks |
|---|---|
| human typed | `type:user`, `origin.kind:"human"`, `promptSource` `typed` (197) / `suggestion_accepted` (42) / `queued` (33) |
| **watcher-typed auto-continue** | **`origin.kind:"human"`, `promptSource:"typed"`** — identical |
| owner-write bridge (`/handoff …`) | `origin.kind:"human"` — identical |
| human text sent mid-turn | **no user entry** — only `queue-operation` + a `queued_command` attachment |
| dictation (`/dd`) | arrives as a Bash **tool result**; no field separates dictated from typed |
| `AskUserQuestion` answer | `toolUseResult.answers` |
| Stop-hook `asyncRewake` injection | `origin.kind:"task-notification"`, text wrapped in `Stop hook blocking error from command …` |
| hook-supplied `AskUserQuestion` answer (`updatedInput.answers`) | **indistinguishable from a real pick** (probe P1b) |
| task notification | `origin.kind:"task-notification"`, `promptSource:"system"` |

Consequence, and the core design constraint of both mechanisms: **anything a machine types or answers
looks human afterwards.** A mechanism that derives answers from "what the human said" by reading the
transcript would, after one cycle, cite its own previous answers and the watcher's prompts as the human's
direction — a self-reinforcing drift loop. The record of human input must be written **at the source**,
by the capturing hook or executor, with provenance, and machine-authored entries must never count as
evidence.

## 5. Platform facts for the mechanism choice (docs + binary + live probes)

Live probes ran in throwaway `claude --model haiku` sessions on a private tmux socket
(`tmux -L hookprobe`), scratch dir only; all cleaned up.

| # | question | result |
|---|---|---|
| P1 | `PreToolUse` on `AskUserQuestion`, `deny` + reason | **fires** (`tool_input.questions` present); dialog skipped; model receives the reason as a **tool error** (`is_error:true`, `toolDenialKind:"permission-rule"`) and acted on it |
| P1b | `PreToolUse` `allow` + `updatedInput` with `answers: {<exact question text>: "Blue"}` | **dialog skipped in 29 ms**; tool result *"Your questions have been answered: … = Blue"*; model treats it as the user's pick — **indistinguishable** |
| P2 | session record while a question dialog is open | `status:"waiting"`, `waitingFor:"input needed"` — a deterministic "blocked on a dialog" signal |
| P3 | Stop hook payload | keys include `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons`, `transcript_path` — no transcript parsing needed for the question text |
| P3 | Stop hook `asyncRewake: true`, exit 2 after 20 s | **the idle session woke itself** at +20.0 s; delivered as a `task-notification` user turn. ⚠ **Trap:** a human message typed during the 20 s did NOT cancel it — the stale answer was still delivered after the human's turn. The hook must re-check that nothing new happened right before exiting 2 |
| P4 | `/goal` across `/clear` | `/goal` exists (a session-scoped Stop hook with an evaluator; `goal_status` attachments) — **does not survive `/clear`** (fresh id → "No goal set"). An open `/goal` panel also swallows typed input |
| binary | `askUserQuestionTimeout` setting (`never`/`60s`/`5m`/`10m`) | a timed-out question returns to the model; the platform's own guidance: *"an unanswered (timed-out) question credits nothing"* |
| binary | `UserPromptSubmit` input | carries `prompt` and `source` ∈ `user · sdk · system · loop_wakeup · schedule_wakeup · poll_event` — but a tmux/owner-typed prompt is still a `user` submit |
| docs | Stop-hook blocks | capped at 8 consecutive (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`); command hooks 600 s default timeout |

**The mechanism choice follows from these, not from preference:**

- **Hooks, not a terminal watcher, deliver answers.** Keystrokes are measured to race hooks (the swallowed
  Enter), to collide with a typing human (§3), and to be recorded as human input (§4). Hook-delivered
  answers are in-protocol, need no writer path, and — for prose stops — are provenance-marked
  (`task-notification`).
- **`AskUserQuestion` → `PreToolUse` hook**: the only point where a dialog can be answered without
  keystrokes (P1b). Because that answer is indistinguishable (P1b), the answer text itself carries the
  label (free-text answers are legal — 6 measured) and the capture record tags it `auto`.
- **Prose question / "done, what next?" → `Stop` hook with `asyncRewake`**: it reads
  `last_assistant_message`, runs the judge without blocking the human, and wakes the session only if the
  answer is certain and **nothing new happened meanwhile** (the P3 trap).
- **The watcher stays the executor for `/clear` only**, and gains the presence gate from §3.
- **`/goal` is not the anchor** — it dies on `/clear` (P4), is a completion check rather than a
  direction, and its evaluator sees no human history. It may be re-armed from the anchor, optionally.

## 6. The link between the two mechanisms

Both answer one question from two sides — *what did the human set this thread to do?* The drift guard asks
whether the agent's next direction still follows it; the auto-answerer asks whether it already answers the
question on screen. So they share three parts, and neither is safe without them:

1. **A thread-scoped, human-sourced intent ledger** — append-only; written at capture time with provenance
   (`human-typed`, `human-dictated`, `human-picked`, `machine-typed`, `auto-answer`); keyed by the
   **thread ID** (the handoff ID, stable along the chain) so it survives every clear; machine entries are
   recorded but can never be cited as evidence.
2. **Thread binding across a clear** — the new session is bound to the thread only when the reload chose
   the handoff by the session's own arm marker. An mtime-chosen reload binds nothing, and an unbound session
   gets neither auto-continue nor auto-answers (the 08:46 near-drift becomes a stop, not a continuation).
3. **A human-silence budget** — automatic cycles and automatic answers since the last human-sourced ledger
   entry are counted; past the budget, both mechanisms stop and the session waits for a human. This bounds
   the length of any unsupervised chain regardless of how well the judge performs.

## 7. Proposed shape (for the change)

**Drift guard (deterministic first):**
- continuity: auto-continue only for a session bound to the thread (marker-chosen reload);
- the charter travels verbatim: the reload injects the thread's first human direction and the most recent
  human decisions from the ledger (quoted, bounded) next to the handoff preview — not the agent's rewrite;
- the auto-continue prompt points at the handoff's **current** next step (later UPDATE blocks supersede
  §5) and stops at any decision the ledger does not already answer;
- optional semantic check at the cycle boundary: a judge compares the new handoff's one-sentence summary and
  next step with the charter → `aligned` / `drifted` / `unclear`; anything but `aligned` withholds the
  auto-continue and logs why;
- the silence budget.

**Auto-answer (certainty is structural):**
- judge output schema: `{class: DERIVABLE | APPROVAL | NEW, answer, evidence: [{entryId, quote}]}`;
- **deterministic validator**: every quote must be a verbatim substring of a human-sourced ledger entry of
  this thread; `NEW` never answers; a question touching a handoff §3 (user decision) item never answers; a
  profile deny-list (irreversible / outward actions: push, deploy, delete, send to a client, spend) never
  answers; the "(Recommended)" label is agent-authored and is never evidence;
- the answer is labeled in its own text (`[auto-answer from your HH:MM message: "…"]`), logged, and tagged
  `auto-answer` in the ledger;
- kill switches mirror auto-clear: `.no-autoanswer` (tree) and `.no-autoanswer-<session8>`;
- **shadow mode first**: the answerer logs what it *would* answer; when the human answers, the pair is
  scored (would-answer vs actual). Arming is a decision taken on that measurement — a wrong answer costs
  more than a wrong clear, because it looks like the human's own decision.

**Package vs project:** the ledger format, capture hooks, binding, validator, budget, gate and hook
templates are generic (package). The judge command/model, deny-list, budget numbers, escalation channel
(e.g. the consumer's Discord route through private-copilot) and dictation adapter live in
`.claude/handoff.profile.md`. Per this repo's CLAUDE.md, any `SKILL.md` change (e.g. §2 decisions citing
their human source) waits until all three consumer profiles are read.

## 8. Open questions (measure or decide before arming)

1. Does `UserPromptSubmit` fire for a mid-turn queued message when it is dequeued? (Measured: such messages
   leave no user entry; unverified whether the hook sees them.) If not, the capture also reads
   `queued_command` attachments.
2. Human-presence signal on the fleet owner-write path — can ownerd report input-line state or last
   keystroke time? (tmux: `capture-pane` of the input line works in principle; unmeasured.)
3. Judge latency and cost on a real ledger (Haiku via `claude -p`), and whether a `PreToolUse` wait of
   that length is acceptable when the human is present — or whether the answerer engages only after a
   presence signal says the human is away.
4. Dictation capture: set-copilot's `dictationHandoverCommand` as the adapter, or a `PostToolUse` on the
   `/dd` Bash call — which one is provable from a file in the repo.
5. ~~Shadow-mode measurement before arming, or arm directly?~~ **Decided 2026-09-13 (user):** arm
   directly, every verdict logged and reviewed post hoc; answer both derivable questions and approvals,
   immediately, whether the human is present or not; the §3 typing-collision fix goes into
   `auto-clear-with-handoff-reload` — which another session archived (`c46661f`) minutes later, so it is
   carried as task group 0 of `autopilot` instead. The feature's name: **autopilot** (user). Change:
   `openspec/changes/autopilot/`. Added by the user the same hour: autopilot must be switchable **off and
   on from a prompt, at any time after arming**; and a turn that ends **waiting on its own background
   work** should continue with independent work when the direction covers it — the user's example: fleet
   pane `b955a632`, "waiting for input" with 2 shells + 1 monitor running, its last message offering
   "ideas 2 (alias table) and 6 (disagreement flag)" before arm HX finishes, and a client prompt
   suggestion ("yes, run the kNN example arm after HX") that is agent-authored, not evidence.

## 9. Measured during implementation (second probe round, 2.1.270, haiku, private tmux socket)

| # | question | result | consequence in the code |
|---|---|---|---|
| M1 | can the executor see a human typing on the input line? | **tmux: yes, with `capture-pane -p -e`.** The input row is `❯` + U+00A0; empty → nothing after it; ghost suggestion / placeholder → text starts with SGR 2 (dim); typed → plain text. A plain capture shows a ghost suggestion exactly like typed text. Scrollback rows and a dialog cursor carry no U+00A0. Not measured: multi-line input, theme changes. **Fleet owner path: no input state** — ownerd's protocol (`protocol.py:39-50`) offers raw output bytes only (`tail`, `attach`); `write` records no timestamp | `templates/presence.mjs` (task 0.2) |
| M2 | does `UserPromptSubmit` fire for a message queued mid-turn? (task 1.3) | **yes, at Enter** (4 ms), 24.5 s before the model absorbed it; the transcript gets `queue-operation` + a `queued_command` attachment and no user entry. The payload carries **no `source` key**. Slash commands fire it with the raw `/name args`. ⚠ **A harness task notification also fires it, with the XML as `prompt`** | queued capture needs nothing extra (task 3.4); `capture-prompt.mjs` skips `<task-notification>` prompts — autopilot's own rewake answer arrives in that shape |
| M3 | can a cleared session find its predecessor? | **no pointer**: the `SessionStart(clear)` payload has only the new id; the runtime record already holds the new id at hook time (rewritten 9 ms earlier); the new transcript never mentions the old id. The hook's process ancestry reaches the `claude` pid in 3 steps. (`bridgeSessionId` is shared across the clear — one sample, inferred, not used) | the watcher logs `{kind: clear, session, pid}` before typing `/clear`; the reinject matches it by the ancestor pid — deterministic for automatic clears; a manual clear binds nothing (announced) |
| M4 | `PostToolUse(AskUserQuestion)` payload | fires; `tool_response` = `tool_input` + `answers` keyed by question text + `annotations`; `tool_use_id` present | `capture-answer.mjs` reads `tool_response.answers` (transcript fallback kept) |

Companion docs: [2026-09-12-auto-clear-and-reload.md](2026-09-12-auto-clear-and-reload.md),
[2026-09-12-background-survival.md](2026-09-12-background-survival.md). Probe artifacts (session-local
scratch, not kept): hook scripts and logged stdin payloads per probe.

## 10. Measured 2026-09-14: the executor typed into a running turn (third writer defect, fixed in task group 0)

At 21:24:39Z and 21:26:17Z (consumer-worktree) the watcher fired `/clear` into a seat that was mid-turn in ONE
long generation (47.3k tokens, 10+ min). Typed text does not execute mid-turn — it QUEUES: both
`/clear`s and both continue prompts sat in the input queue ("Press up to edit queued messages"), the
seat worked 25+ min past the limit, and the freshness gate kept passing because a single long
generation writes nothing to the transcript. The 21:25:16Z "CONTINUE confirmed" was a false positive:
the whole-file grep matched "auto-continue" in a `skill_listing` attachment present from the session's
birth. The first queued `/clear` executed only when the turn ended (21:27:52Z → `ce67a4d9`, reinject ok).

Esc probe (throwaway tmux pane, 2.1.270, haiku — captures in the session scratch, findings here):

| # | question | result |
|---|---|---|
| E1 | what marks a working turn in a raw `capture-pane -p -e`? | a spinner status line: `✻ Wibbling… ` / `* Dilly-dallying… ` — one animation glyph (or `*`), one space, a Capitalized gerund, U+2026; the glyph rotates, the shape does not. No "esc to interrupt" hint exists on this build |
| E2 | what does typing + Enter mid-turn do? | the text shows as a queued dim line and the input row becomes `❯ Press up to edit queued messages` — presence.mjs already reads that row as "typed" |
| E3 | what does ONE Escape do? | interrupts the turn (`⎿ Interrupted · What should Claude do instead?`); the queued message is NOT submitted — it lands back in the input line, editable |
| E4 | is the seat clear-safe immediately after the interrupt? | NO — the screen still shows a spinner (`* Dilly-dallying…`) while the interrupt settles; only ~2 s later does it read idle. The executor must re-verify after the Escape |
| E5 | what do further Escapes do? | with text in the input line: they CLEAR the text; on an empty idle line: they open a small popover (a `● high · /effort` line) that swallows typed input — the P4 trap class. ⇒ ONE Escape, verified, never repeated blindly |

Fixes in the executor (`templates/turn-state.mjs`, `templates/watch-auto-clear.sh`, tests in
`test/autopilot.test.mjs` naming the 21:24/21:25/21:26 bugs): turn gate + one verified Escape; fire
lock `.firelock-<pid>` holding re-fires until the pid's sessionId changes or 10 min; the continue
confirm counts only a fragment inside a USER STRING entry (probe M2: a queued message leaves no user
entry). Owner-path turn detection reads the same spinner/queue patterns off the ownerd tail — NOT
fully measured on a long busy tail (marked in the code header).
